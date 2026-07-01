import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export class MailCatcherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // ── Secrets ──────────────────────────────────────────
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'mailcatcher/jwt-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    const encryptionKey = new secretsmanager.Secret(this, 'EncryptionKey', {
      secretName: 'mailcatcher/encryption-key',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    // ── RDS PostgreSQL ──────────────────────────────────
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc });
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      databaseName: 'mailcatcher',
      credentials: rds.Credentials.fromGeneratedSecret('mailcatcher', { secretName: 'mailcatcher/db' }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      multiAz: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection: true,
    });

    // ── ElastiCache Redis ───────────────────────────────
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc });
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'MailCatcher Redis',
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
    });
    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });

    // ── ECS Cluster ─────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const image = new ecr_assets.DockerImageAsset(this, 'BackendImage', {
      directory: path.join(__dirname, '..', '..'),
      file: 'Dockerfile',
    });

    // ── ECS Task Definition ─────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    const dbSecret = database.secret!;
    const redisHost = redis.attrRedisEndpointAddress;
    const redisPort = redis.attrRedisEndpointPort;

    const container = taskDef.addContainer('backend', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mailcatcher',
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        DB_BACKEND: 'postgres',
        PG_PORT: '5432',
        PG_DATABASE: 'mailcatcher',
        FETCH_CONCURRENCY: '20',
        NODE_ENV: 'production',
      },
      secrets: {
        PG_HOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        PG_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        PG_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
      },
      portMappings: [{ containerPort: 3000 }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/healthz || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });
    // REDIS_URL is set via environment since it's not a secret
    container.addEnvironment('REDIS_URL', `redis://${redisHost}:${redisPort}`);

    // ── ALB (public, restricted to CloudFront) ──────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc });
    albSg.addIngressRule(ec2.Peer.prefixList('pl-58a04531'), ec2.Port.tcp(80), 'CloudFront');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const listener = alb.addListener('Http', { port: 80 });

    // ── ECS Service ─────────────────────────────────────
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', { vpc });
    albSg.connections.allowTo(serviceSg, ec2.Port.tcp(3000));
    dbSg.addIngressRule(serviceSg, ec2.Port.tcp(5432));
    redisSg.addIngressRule(serviceSg, ec2.Port.tcp(6379));
    // Outbound IMAP
    serviceSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(993), 'IMAP');
    serviceSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSg],
      assignPublicIp: false,
    });

    const targetGroup = listener.addTargets('Backend', {
      port: 3000,
      targets: [service],
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: '200',
      },
    });

    // Auto scaling
    const scaling = service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 });
    scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 60 });

    // ── S3 (frontend) ───────────────────────────────────
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'server', 'public'))],
      destinationBucket: frontendBucket,
    });

    // ── CloudFront ──────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, 'CDN', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.LoadBalancerV2Origin(alb, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
        '/healthz': {
          origin: new origins.LoadBalancerV2Origin(alb, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY }),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responsePagePath: '/index.html', responseHttpStatus: 200 },
        { httpStatus: 404, responsePagePath: '/index.html', responseHttpStatus: 200 },
      ],
    });

    // ── Outputs ─────────────────────────────────────────
    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: database.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: redisHost });
  }
}

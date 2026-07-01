#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MailCatcherStack } from '../lib/stack';

const app = new cdk.App();

new MailCatcherStack(app, 'MailCatcherStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
});

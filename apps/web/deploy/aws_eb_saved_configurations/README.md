# Elastic Beanstalk saved configurations

This directory is where an exported Elastic Beanstalk saved configuration for each environment of the project's hosted web deployment is kept, one file per environment, so a setting that drifts from what the deployment and assurance documents claim shows up in a diff. The procedure that refreshes and applies these files -- and the settings recorded as prose because no export carries them -- is in [docs/DEPLOYMENT.md](../../../../docs/DEPLOYMENT.md#the-projects-hosted-web-deployment).

It sits beside `aws_eb/` rather than inside it because that tree is the deployed payload: the packaging step in [`eb_build_and_test.yaml`](../../../../.github/workflows/eb_build_and_test.yaml) copies all of it into the application bundle, and [`eb_deploy.yaml`](../../../../.github/workflows/eb_deploy.yaml) redeploys the environment on a push that touches it. A configuration export belongs to neither: nothing on the instance reads it, and re-exporting it is not a reason to redeploy the application.

## Expected files

| File                 | Environment                                                    |
| -------------------- | -------------------------------------------------------------- |
| `production.cfg.yml` | The production environment, serving the production public name |
| `staging.cfg.yml`    | The staging environment, serving the staging public name       |

The two names match the deployment environments `eb_deploy.yaml` maps a branch onto (`main` -> Production, `staging` -> Staging), so a reader who has only the repository can tell which file belongs where. Neither file is present yet: an export needs credentials for the AWS account that holds the environments, which no CI job and no development container has, so the maintainer runs the export outside the container and commits the result.

## Producing a file

Run one of these per environment, substituting the application and environment names the deploy workflow holds as its `EB_APPLICATION_NAME` variable and its `EB_ENVIRONMENT_NAME` secret:

- EB CLI: `eb config save <environment-name> --cfg production`. It writes `.elasticbeanstalk/saved_configs/production.cfg.yml` under the directory it runs from; copy that file here.
- AWS CLI: `aws elasticbeanstalk describe-configuration-settings --application-name <application-name> --environment-name <environment-name>`, saved here as the JSON counterpart of the file above if the YAML route is unavailable.

Whichever route is used, commit the file unedited apart from the redactions below, and say in the commit message which command produced it. Neither command is driven from this repository, so the first run is also the check on the exact flags: correct this file with what the tool accepted.

## Redactions before committing

An export states the environment as the account holds it, so it carries identifiers this repository keeps out of public view: the AWS account id inside every role ARN (the deploy workflow reads it from its `AWS_ACCOUNT_ID` secret), the environment name (its `EB_ENVIRONMENT_NAME` secret), and the ids of the security groups, subnets, and instance profile.

Committing an export unedited publishes all of that, which is a disclosure decision rather than a mechanical step. Until the maintainer takes it, replace each such value with an obviously fake placeholder, keep the option name and the rest of the value intact -- the point of the file is that a changed setting stays visible -- and note in this README which fields were replaced, so a later apply knows what to substitute back.

## Inbound rules as option settings

A security-group rule created or removed by an `authorize-security-group-ingress` or `revoke-security-group-ingress` call is not part of the environment configuration, so an operation that recreates an environment's own groups from its CloudFormation stack does not replay it. An option setting is part of the configuration. The inbound posture therefore belongs in these files rather than in a remembered sequence of revokes, as far as an option setting can express it:

- **No inbound `:22`.** Elastic Beanstalk carries the SSH ingress it creates as `SSHSourceRestriction`, in the `aws:autoscaling:launchconfiguration` namespace. The recorded posture is no inbound `:22` at all, with Session Manager as the only shell route. Which value of that option expresses that, and whether an export carries the option at all, is settled from the export rather than asserted here: nothing in a development container can ask the API.
- **`:443` from Cloudflare's ranges only.** That rule lives in a security group the platform did not create, shared by both environments, so its rule list is not an option setting of either environment. What the configuration can carry is the attachment of that group to the instances (`SecurityGroups`, same namespace). The rule's contents stay recorded as values in `docs/DEPLOYMENT.md`; applying them from the repository is the later infrastructure-as-code step.
- **No inbound `:80`.** Which option setting, if any, expresses that on a single-instance environment is unrecorded; the export settles it.

Cloudflare publishes its ranges as a list that changes, and nothing reconciles the rule against it. A range Cloudflare adds is dropped at the origin, which surfaces as an intermittent edge error rather than as an outage.

## The verification this directory still needs

The inbound rules are known to survive a configuration deployment, measured 2026-09-17. Whether they survive `rebuild-environment` or a managed platform update, either of which recreates the platform's own security groups, is unverified: driving it needs the live account, so it is the maintainer's to run outside the container. Record the result here when it is run, with the date and the operation that was run.

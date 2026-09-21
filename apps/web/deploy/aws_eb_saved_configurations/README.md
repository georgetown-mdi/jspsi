# Elastic Beanstalk saved configurations

This directory holds an exported configuration of each environment of the project's hosted web deployment, one file per environment, so a setting that drifts from what the deployment and assurance documents claim shows up in a diff. Beside them it holds the two origin values no export carries -- the certificate expiry and Cloudflare's published ranges -- and the check that compares those against the account. The procedure that refreshes and applies these files -- and the settings recorded as prose because no export carries them -- is in [docs/DEPLOYMENT.md](../../../../docs/DEPLOYMENT.md#the-projects-hosted-web-deployment).

It sits beside `aws_eb/` rather than inside it because that tree is the deployed payload: the packaging step in [`eb_build_and_test.yaml`](../../../../.github/workflows/eb_build_and_test.yaml) copies all of it into the application bundle, and [`eb_deploy.yaml`](../../../../.github/workflows/eb_deploy.yaml) redeploys the environment on a push that touches it. A configuration export belongs to neither: nothing on the instance reads it, and re-exporting it is not a reason to redeploy the application.

## The files

| File              | Environment                                                    |
| ----------------- | -------------------------------------------------------------- |
| `production.json` | The production environment, serving the production public name |
| `staging.json`    | The staging environment, serving the staging public name       |

The two names match the deployment environments `eb_deploy.yaml` maps a branch onto (`main` -> Production, `staging` -> Staging), so a reader who has only the repository can tell which file belongs where. Each is an `aws elasticbeanstalk describe-configuration-settings` response with the identifiers below replaced. Producing one needs credentials for the AWS account that holds the environments, which no CI job and no development container has, so the maintainer runs the export outside the container.

## Refreshing a file

1. Export the environment, substituting the application and environment names the deploy workflow holds as its `EB_APPLICATION_NAME` variable and its `EB_ENVIRONMENT_NAME` secret:

   ```sh
   aws elasticbeanstalk describe-configuration-settings \
     --application-name <application-name> \
     --environment-name <environment-name> > export.json
   ```

2. Rewrite it into the committed form, from a path or on standard input:

   ```sh
   node redact.mjs export.json > production.json
   ```

3. Commit the result and read the diff: a line that changed is a setting that changed.

`redact.mjs` exits non-zero and names the value it could not find rather than writing a file, so an export shaped differently than the ones above stops the refresh instead of committing an identifier. The `EC2KeyName` option is the one value it accepts an export without: an environment with no key pair states that option with no value at all. `scripts/eb-saved-configuration-redact.test.mjs` drives that refusal and each replacement against a synthetic export; it runs with `npm run test:scripts`.

## What the redaction replaces

| Placeholder               | Replaces                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `<account-id>`            | The AWS account id, wherever it appears, inside ARNs included                                |
| `<application-name>`      | The `ApplicationName` value, wherever it appears                                             |
| `<environment-name>`      | The `EnvironmentName` value, wherever it appears, inside the notification topic ARN included  |
| `<notification-endpoint>` | The `aws:elasticbeanstalk:sns:topics` / `Notification Endpoint` address                       |
| `<ec2-key-name>`          | The `EC2KeyName` value, when the export states one                                            |

Each replacement is made by matching the value the export itself states, so the script holds no secret of its own. It also drops the members that change on every export -- `DateCreated`, `DateUpdated`, `DeploymentStatus` -- and sorts the option settings by namespace and then option name, so two exports diff against each other rather than against their ordering.

Everything else is kept as exported, including the security group, subnet and VPC ids, the region, the platform ARN and the option values: those are what the file is read for. An apply substitutes the replaced values back, from the account itself and from the workflow variable and secret named above.

## Inbound rules as option settings

A security-group rule created or removed by an `authorize-security-group-ingress` or `revoke-security-group-ingress` call is not part of the environment configuration, so an operation that recreates an environment's own groups from its CloudFormation stack does not replay it. An option setting is part of the configuration. The inbound posture therefore belongs in these files rather than in a remembered sequence of revokes, as far as an option setting can express it:

- **Inbound `:22`.** Elastic Beanstalk creates the SSH ingress from `SSHSourceRestriction`, in the `aws:autoscaling:launchconfiguration` namespace, only when `EC2KeyName` is set. The committed files record `EC2KeyName` absent, so the platform creates no SSH ingress when it recreates an environment's groups, and the `SSHSourceRestriction` the files carry, still the platform default, is inert. Session Manager is the shell route; the rule set measured on the live groups is recorded separately in `docs/DEPLOYMENT.md`, and the two are not the same fact.
- **`:443` from Cloudflare's ranges only.** That rule lives in a security group the platform did not create, shared by both environments, so its rule list is not an option setting of either environment. What the configuration can carry is the attachment of that group to the instances (`SecurityGroups`, same namespace). The rule's contents stay recorded as values in `docs/DEPLOYMENT.md`; applying them from the repository is the later infrastructure-as-code step.
- **No inbound `:80`.** Which option setting, if any, expresses that on a single-instance environment is unrecorded; the committed files are where to read it.

Cloudflare publishes its ranges as a list that changes, and a range it adds is dropped at the origin, which shows as an intermittent edge error rather than as an outage. Reconciling the rule against the published list is what the check below does.

## Checking the origin certificate and the Cloudflare ranges

Two values decide whether the origin keeps answering the edge, and neither is an option setting: the origin certificate's expiry -- an expired certificate answers Full (strict) with a 526 on both public names -- and the port-443 rule list against Cloudflare's published ranges. `check-origin-drift.mjs` compares both:

```sh
node check-origin-drift.mjs            # compare, using a 30-day expiry margin
node check-origin-drift.mjs --margin-days 60
```

| Exit | What it means                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Both comparisons ran and agreed                                                                           |
| 1    | A comparison found a difference: the certificate is inside the margin, a rule differs, or the record does |
| 2    | A comparison could not run -- no credentials, no route to `cloudflare.com`, or an unreadable answer       |

Every value it compares is read live. A read that fails -- the certificate from the account, the security group, or either published list -- ends that comparison there: the line names what could not be read and why, the run exits 2, and nothing is compared against `recorded-origin.json` in its place, so a 0 is only ever a run that read both sides. A run that finds any live value differing from the record prints the record as it would now read, ready to paste into `recorded-origin.json`; a run that agrees prints nothing to paste. The script writes no file of its own.

It reads the account through the `aws` CLI, as the refresh commands above do, so it runs from a machine holding read credentials for the account: `sts:GetCallerIdentity`, `s3:GetObject` on the deployment bucket's `cert/` prefix, and `ec2:DescribeSecurityGroups`. No CI job and no development container holds those, so the run is the maintainer's; the cadence and what to do about each result are in [docs/DEPLOYMENT.md](../../../../docs/DEPLOYMENT.md#checking-for-certificate-and-range-drift). The script prints no account id and no bucket name of its own, but an AWS CLI error it passes through can name either. Every call it makes is bounded -- 30 seconds for a published list, 2 minutes for an `aws` call, which is given no standard input -- so an unreachable host or a CLI waiting on a prompt ends as a value the run could not read rather than as a run that never returns.

What it reads comes from the committed files beside it rather than from a typed-in identifier: the one security group both environments attach is the shared group that carries the port-443 rule, and the region is the one their ARNs state. The certificate is the object `.platform/hooks/prebuild/download_certificates.sh` installs on the instance, read from the same bucket and key. Ranges compare as addresses rather than as text, so two spellings of one range agree; a range on either side that is no CIDR is named as a value the check cannot compare.

## The recorded values

`recorded-origin.json` is the committed copy of what the account and Cloudflare held when it was last written, and what a reviewer reads a drift out of a diff from:

- `origin_certificate` -- the expiry of the certificate the origin serves, and when that was recorded. The check compares the deployed certificate against this date as well as against the margin, so a replacement installed without a commit here fails the check.
- `cloudflare_ranges` -- the two published lists, the date they were fetched, and the URLs they are fetched from. The check reads those URLs and compares the rules against both the published lists and these. `fetched: null` states that no snapshot has been taken yet, which the check reports as a difference to commit.

It is updated by hand, from the block a differing run prints: replace the file with that block and commit it, after checking that what changed is what was meant to change. The diff is the record of what Cloudflare changed, or of which certificate the origin now serves.

## The verification this directory still needs

The inbound rules are known to survive a configuration deployment, measured 2026-09-17. Whether they survive `rebuild-environment` or a managed platform update, either of which recreates the platform's own security groups, is unverified: driving it needs the live account, so it is the maintainer's to run outside the container. Record the result here when it is run, with the date and the operation that was run.

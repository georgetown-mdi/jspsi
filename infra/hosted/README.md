# The project's hosted environment, as OpenTofu

This root describes the project's own hosted deployment of the web application -- the staging and production Elastic Beanstalk environments and the Cloudflare zone in front of them -- so the inbound rules and the edge settings are code a reviewer reads, and a drift is a plan that is not empty. It is about that deployment alone; an agency hosting the web application itself starts from [the reference payload](../../apps/web/deploy/aws_eb/) and [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#peer-coordination-server) instead.

Nothing in the repository runs it: no workflow, script or package manifest invokes `tofu`. The maintainer applies it from a machine holding credentials for the AWS account and the Cloudflare zone.

## Provenance

Agent-authored and not yet run. It was written in a container with no `tofu` binary and no route to either provider's API, so neither `tofu validate` nor a plan has been run against it. Read every resource as a proposal until [the first run](#the-first-run-against-the-live-account) has confirmed it, and correct this README with what that run found.

## What it describes

| File                | What it holds                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environments.tf`   | Both environments (`aws_elastic_beanstalk_environment.hosted["production"]` and `["staging"]`), their platform version, and the option settings both take                                                                                                                  |
| `security_group.tf` | The one security group both instances attach: `:443` from Cloudflare's published ranges, read at plan time from the Cloudflare provider's `cloudflare_ip_ranges` data source, and no other inbound rule                                                                    |
| `cloudflare.tf`     | A proxied DNS record for each public name, and three zone settings: SSL/TLS mode `Full (strict)` (`ssl = strict`), Always Use HTTPS, and HSTS at `max-age=2592000` without `includeSubDomains` or preload -- the values [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#recorded-settings-and-their-source) records |
| `variables.tf`      | Every account-specific value -- the account id, application and environment names, VPC and subnet ids, the notification address, the zone id and the public names -- with no default                                                                                   |

The environments, the security group and the DNS records have `prevent_destroy`, so a plan that would replace one fails instead of proposing it. The environments ignore `version_label`: the deploy workflow ([`eb_deploy.yaml`](../../.github/workflows/eb_deploy.yaml)) owns the application version, and an apply here does not roll it back.

### Option settings it leaves out

Both environments take every option setting the committed configuration files under [`apps/web/deploy/aws_eb_saved_configurations/`](../../apps/web/deploy/aws_eb_saved_configurations/README.md) state a value for, with the values those files state, except:

- `aws:autoscaling:launchconfiguration` `ImageId`: the machine image follows the platform version, which `platform_arn` states.
- The `aws:cloudformation:template:parameter` namespace: parameters the platform derives from other options and its own assets.
- The `aws:elasticbeanstalk:control` namespace: the platform's own launch-control values rather than an operator choice.
- `aws:elasticbeanstalk:sns:topics` `Notification Topic ARN`: the platform creates the topic from `Notification Endpoint`, which is declared.
- `EC2KeyName` and `SSHSourceRestriction`: neither environment has a key pair, so no SSH rule exists, and Session Manager is the shell route. An option setting cannot state "absent"; a key pair set outside this root shows in the re-exported file, not in a plan.
- Options the files state with no value, such as `RootVolumeSize` or `Custom Availability Zones`.

Two settings differ from the committed files by design: `DisableDefaultEC2SecurityGroup` is `true`, and `SecurityGroups` names the one group in `security_group.tf`. The next section is why.

## How the inbound rules are held

The intended posture is one security group per instance, admitting `:443` from Cloudflare's published ranges and nothing else inbound, and holding after a `rebuild-environment` or a platform update as well as after a configuration deployment.

By default Elastic Beanstalk creates a security group of its own for each environment's instances, owned by the environment's CloudFormation stack, and a rebuild or a platform update recreates it from the platform's template. A rule list this root does not own cannot be held by it. So this root sets `DisableDefaultEC2SecurityGroup` to `true` on both environments: the platform creates no group of its own, and the group in `security_group.tf` -- owned by this root, with inline rules that make its inbound list exclusive -- is the only one attached. Because the choice is an option setting, it is part of the environment configuration, which a rebuild replays; a revoke is not.

The alternatives, and why they were not taken:

- **Look the platform's group up with a data source and attach rules to it** (`aws_vpc_security_group_ingress_rule`). That can add rules to a group but cannot remove one it did not create, and a rebuild gives the group a new id and a fresh rule set that no apply has seen.
- **Import the platform's group into this state.** Inline rules on an imported group would make its list exclusive, so an apply removes any rule not declared here. But the group has two owners, and after a rebuild the state names a group that no longer exists: holding the posture needs a re-import and an apply after every rebuild, and between the two the group is the platform's.

The shared group this root adopts is the group both environments already attach, so adopting it changes no id either instance uses.

## State and credentials

Nothing this root reads or writes as a secret is in the repository:

- **State** is in an S3 bucket the operator chooses, configured by a gitignored `backend.hcl` passed at `tofu init` (template: `backend.hcl.example`). Keep the bucket private, versioned and encrypted at rest: the state holds every value in `terraform.tfvars`, the notification address and the account id included. A local backend is an acceptable choice for a single maintainer, as long as its state file lives outside the repository checkout: put `terraform { backend "local" { path = "<a path outside the checkout>" } }` in an `override.tf` in this directory, which is gitignored and replaces the backend block, and run `tofu init` without `-backend-config`.
- **Values** are in a gitignored `terraform.tfvars` (template: `terraform.tfvars.example`), which `tofu` reads from this directory by default.
- **Credentials** come from the environment and are never variables: the AWS provider's default chain (`AWS_PROFILE`, or the `AWS_*` variables) and `CLOUDFLARE_API_TOKEN`. The AWS provider refuses to run against any account other than `aws_account_id`. The Cloudflare token needs Zone Settings edit and DNS edit on the one zone; the AWS principal needs to update both environments and write the one security group (unverified: the `AdministratorAccess-AWSElasticBeanstalk` managed policy is expected to cover the environment half).

`.gitignore` in this directory keeps `.terraform/`, state, plan files, tfvars and `backend.hcl` out of a commit. Commit `.terraform.lock.hcl`, which `tofu init` writes: it pins the provider builds a later run installs.

A plan prints the notification address, the account id and the resource names this repository otherwise keeps redacted. Do not paste plan output anywhere public.

## Applying

```sh
cd infra/hosted
cp backend.hcl.example backend.hcl            # fill in the state bucket
cp terraform.tfvars.example terraform.tfvars  # fill in every <...>
export AWS_PROFILE=<profile> CLOUDFLARE_API_TOKEN=<token>
tofu init -backend-config=backend.hcl
tofu plan -out=hosted.tfplan
tofu apply hosted.tfplan
```

A change to an environment's security groups replaces its single instance: expect a short outage on that public name while it does. Apply staging first and check it before production:

```sh
tofu plan -target='aws_elastic_beanstalk_environment.hosted["staging"]' -out=staging.tfplan
tofu apply staging.tfplan
tofu plan -out=hosted.tfplan   # then the rest
tofu apply hosted.tfplan
```

`-target` takes the environment's dependencies with it, so the staging apply also writes the security group, which production attaches too.

After any apply that changed an environment, re-export both configuration files and commit them ([the refresh procedure](../../apps/web/deploy/aws_eb_saved_configurations/README.md#refreshing-a-file)), and update the recorded values in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#recorded-settings-and-their-source) that the apply changed.

### Adopting the live resources

The resources already exist, so the first run adopts them into state rather than creating them: an apply that tried to create them would collide with the live ones. Import each once, after `tofu init` and before the first plan:

```sh
tofu import aws_security_group.origin <sg-...>
tofu import 'aws_elastic_beanstalk_environment.hosted["staging"]' <e-...>
tofu import 'aws_elastic_beanstalk_environment.hosted["production"]' <e-...>
tofu import 'cloudflare_dns_record.public_name["staging"]' '<zone-id>/<record-id>'
tofu import 'cloudflare_dns_record.public_name["production"]' '<zone-id>/<record-id>'
tofu import cloudflare_zone_setting.ssl '<zone-id>/ssl'
tofu import cloudflare_zone_setting.always_use_https '<zone-id>/always_use_https'
tofu import cloudflare_zone_setting.hsts '<zone-id>/security_header'
```

The group id is the one both committed configuration files name in `SecurityGroups`. An environment id is `aws elasticbeanstalk describe-environments --environment-names <name> --query 'Environments[0].EnvironmentId'`. A record id is the `id` of `GET https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records?name=<public name>`.

## Reading a plan for drift

Run `tofu plan -detailed-exitcode`. Its exit code is the answer: `0` the account and the zone match this root, `2` they differ and the plan lists how, `1` the plan could not run. Read a `2` as follows:

- **`~` on `aws_security_group.origin`, an `ingress` range added or removed.** Either Cloudflare changed its published ranges, which the data source reads live, or someone edited the group. A rule added outside this root shows as a block the plan removes. The [daily origin drift check](../../docs/DEPLOYMENT.md#checking-for-certificate-and-range-drift) reports the range half of this unattended; the plan is where it is corrected.
- **`~` on a `setting` of an environment.** A declared option was changed outside this root, and the re-exported file shows the same change. Apply to put it back, or change `environments.tf` and apply, if the change was meant.
- **`~` on a `cloudflare_zone_setting` or `proxied` on a record.** An edge setting was changed in the dashboard. The same choice.
- **Anything that must be replaced.** Stop and read it. `prevent_destroy` makes the plan fail for the environments, the group and the records rather than proposing it.

Above the planned changes, `Objects have changed outside of OpenTofu` lists what the refresh found changed, including a change the configuration then agrees with. Read it too.

What a plan cannot show: an option setting this root leaves out (the list above), and anything neither provider exposes to it. The re-exported configuration files are the record of those.

## The first run against the live account

For whoever runs this root for the first time, with the tools and credentials this repository's container lacks. Each step names what confirms the root and what refutes it; record what was found in [Provenance](#provenance), and fix the root rather than the expectation where they disagree.

1. **Syntax and references.** `tofu init -backend=false && tofu validate`. Confirmed by `Success! The configuration is valid.` Refuted by any error; the likeliest are an attribute name in one of the unverified assumptions below.
2. **Provider lock.** `tofu init -backend-config=backend.hcl`, then commit `.terraform.lock.hcl`. Confirmed by an init that resolves `hashicorp/aws` 6.x and `cloudflare/cloudflare` 5.x and a lock file naming both.
3. **Adoption.** Every `tofu import` above ends in `Import successful!`. A zone-setting import that fails with an unrecognized id format means the provider takes another form; its documentation for `cloudflare_zone_setting` states it.
4. **The recorded values are the live ones.** `tofu plan`, before anything else changes. Confirmed when the only changes are the ones this root makes by design: on each environment, the `DisableDefaultEC2SecurityGroup` and `SecurityGroups` settings, plus the other declared settings the provider has not recorded in state before (an in-place update on the `setting` set, with values matching the committed files); on the group, the rule description, and any range Cloudflare has published or withdrawn since 2026-09-17. Refuted by a zone setting, a record's `proxied` or `content`, the group's egress, a tag, or a declared option value that differs from `docs/DEPLOYMENT.md` and the committed files: the root or the record is wrong, and which one is the question to settle before applying.
5. **The inbound posture.** Apply staging, then run `aws ec2 describe-security-groups` on every group the staging instance attaches (`aws ec2 describe-instances` names them). Confirmed when it attaches exactly one group, the one in state as `aws_security_group.origin`, whose inbound list is one rule, `tcp/443`, from the ranges the plan read, and when the staging public name answers `200` over HTTPS. Refuted by a second group, any other inbound rule, or a health status other than Ok.
6. **The posture survives a rebuild.** `aws elasticbeanstalk rebuild-environment` on staging, then step 5 again, and `tofu plan -detailed-exitcode` exits `0`. Then production, by the same steps. Record the date and the operation here and in [the saved-configuration README](../../apps/web/deploy/aws_eb_saved_configurations/README.md#the-verification-this-directory-still-needs).
7. **The edge.** `curl -sI http://<public name>/` answers `301` to the `https://` form, and `curl -sI https://<public name>/` states `strict-transport-security: max-age=2592000` with no `includeSubDomains` or `preload`, on both names.

### Assumptions no run has checked

Each is something the first run confirms or corrects:

- OpenTofu 1.10 or later, for the S3 backend's `use_lockfile`. On an older release, drop that line and name a DynamoDB lock table in `backend.hcl` instead.
- The Cloudflare provider's v5 schema: the `cloudflare_ip_ranges` data source exposes `ipv4_cidrs` and `ipv6_cidrs`; `cloudflare_zone_setting` takes `setting_id` and `value`, with HSTS under `security_header` as a `strict_transport_security` object; `cloudflare_dns_record` takes the full name and requires `ttl`, where `1` is automatic.
- HSTS `nosniff` is `false`. `docs/DEPLOYMENT.md` does not record it; if the plan proposes changing it, record the live value there and match it here.
- Each public name is a `CNAME` to its environment's Elastic Beanstalk name. If the live record is an `A` record to the instance's Elastic IP, the plan proposes a change of type and content; a `CNAME` follows a rebuild that changes the address, which is why it is proposed here.
- The AWS provider's `aws_elastic_beanstalk_environment` compares only the `setting` blocks declared here, so an option this root leaves out never shows in a plan, and an imported environment shows its declared settings as an in-place update on the first plan. Whether it reports a perpetual difference for an option the platform stores with a resource name (`ResourceName` in the committed files) is unverified.
- The shared group's egress is the single allow-all IPv4 rule, and no tag on either environment or the group needs declaring.
- On a single-instance environment, `DisableDefaultEC2SecurityGroup = true` with one group in `SecurityGroups` is accepted, replaces the instance, and leaves the platform's group deleted with the stack update.
- A change to the inline rule's ranges is applied as a revoke of the withdrawn ranges and an authorize of the added ones; which the provider calls first is unverified, and a revoke first drops requests from a range being replaced for the seconds between the two.
- Changing the inline rule description on the adopted group is an in-place update. If the provider revokes and re-authorizes the rule to change it, the first apply drops requests from the edge for the seconds between the two calls.

# The project's hosted environment, as OpenTofu

This root describes the project's own hosted deployment of the web application -- the staging and production Elastic Beanstalk environments and the Cloudflare zone in front of them -- so the inbound rules and the edge settings are code a reviewer reads, and a drift is a plan that is not empty. It is about that deployment alone; an agency hosting the web application itself starts from [the reference payload](../../apps/web/deploy/aws_eb/) and [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#peer-coordination-server) instead.

Nothing in the repository runs it: no workflow, script or package manifest invokes `tofu`. The maintainer applies it from a machine holding credentials for the AWS account and the Cloudflare zone.

## Provenance

Agent-authored in a container with no `tofu` binary and no route to either provider's API, then validated, planned and applied against the live account and zone by the maintainer. Record here what each later run finds that this README does not already state.

- **2026-09-22, validated and planned, not applied.** A run outside the container, with OpenTofu 1.12.6, `hashicorp/aws` 6.66.0 and `cloudflare/cloudflare` 5.25.0, passed `tofu init -backend=false` and `tofu validate`, imported the security group and the three zone settings into a local state, and planned against the live account and zone. The zone settings planned with no change, and the environments' declared option values match the live ones except the two this root changes by design. The one change on an adopted resource was the group: its `Name` tag removed and its rule rewritten for a new description, both of which the root declares.
- **2026-09-23, first apply.** With the same provider versions and an S3 backend, `tofu init` wrote the committed lock file, and all eight imports succeeded with a Cloudflare token holding Zone Settings Read and DNS Read only. The first full plan was 0 to add, 2 to change, 0 to destroy: on each environment, the `DisableDefaultEC2SecurityGroup` and `SecurityGroups` settings, and no change on the group, the records or the zone settings. Staging was applied with `-target`, then production. On each, the instance was replaced, the platform's own group was deleted, and exactly one group -- this root's -- stayed attached, with health Ok and HTTPS `200`. A `rebuild-environment` on each followed and created no platform group, and a plan after it exited `0`. The production apply hit the hazard in [Before an apply that changes an environment's security groups](#before-an-apply-that-changes-an-environments-security-groups): another instance attached to the platform's group blocked its deletion. The edge answered as step 7 of the first run expects, on both names.

What each assumption came to is in [What the first run found](#what-the-first-run-found).

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

The intended posture is one security group per instance, admitting `:443` from Cloudflare's published ranges and nothing else inbound, and holding after a `rebuild-environment` or a platform update as well as after a configuration deployment. This root sets `DisableDefaultEC2SecurityGroup` to `true` on both environments, so the platform creates no group of its own and the group in `security_group.tf` -- owned by this root, with inline rules that make its inbound list exclusive, and the group both environments already attach -- is the only one attached; a rebuild replays the setting. Why this and not a data-source lookup or an import of the platform's group is in [the design note](../../docs/notes/hosted-environment-opentofu.md).

## State and credentials

Nothing this root reads or writes as a secret is in the repository:

- **State** is in an S3 bucket the operator chooses, configured by a gitignored `backend.hcl` passed at `tofu init` (template: `backend.hcl.example`). Keep the bucket private, versioned and encrypted at rest: the state holds every value in `terraform.tfvars`, the notification address and the account id included. A local backend is an acceptable choice for a single maintainer, as long as its state file lives outside the repository checkout: put `terraform { backend "local" { path = "<a path outside the checkout>" } }` in an `override.tf` in this directory, which is gitignored and replaces the backend block, and run `tofu init` without `-backend-config`.
- **Values** are in a gitignored `terraform.tfvars` (template: `terraform.tfvars.example`), which `tofu` reads from this directory by default.
- **Credentials** come from the environment and are never variables: the AWS provider's default chain (`AWS_PROFILE`, or the `AWS_*` variables) and `CLOUDFLARE_API_TOKEN`. The AWS provider refuses to run against any account other than `aws_account_id`. The Cloudflare token needs Zone -> Zone Settings -> Read and Zone -> DNS -> Read on the one zone to import and plan, and Edit on both to apply; without Zone Settings Read, the zone-setting imports fail with `403`. The permission list `GET /zones` returns is the account member's, not the token's, so it does not show what the token holds; the AWS principal needs to update both environments and write the one security group (unverified: the `AdministratorAccess-AWSElasticBeanstalk` managed policy is expected to cover the environment half).

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

An apply that changes no Cloudflare resource -- the plan lists none -- runs with the Read-only token that imports and plans; Edit is needed only when the plan changes a record or a zone setting.

### Before an apply that changes an environment's security groups

An update that sets `DisableDefaultEC2SecurityGroup` to `true` on an environment that still has the platform's own group deletes that group as part of the environment's CloudFormation stack update. Anything else attached to the group -- an EC2 instance launched outside Elastic Beanstalk, say -- blocks the deletion: CloudFormation retries it for about 17 minutes and then fails with `has a dependent object`, and `tofu apply` exits `1` at its 20-minute `wait_for_ready_timeout` (`timeout while waiting for state to become 'Ready'`), although the settings change has landed on the environment.

- Before applying, list what else uses the platform's group, and move each one to a group of its own: `aws ec2 describe-network-interfaces --filters Name=group-id,Values=<sg-...>` names every interface attached to it, and only the environment's own instance should be among them.
- After any apply that timed out, run `tofu plan -detailed-exitcode`. An exit `0` means the change landed. If the environment is not Ready, detach whatever still holds the old platform group, delete that group by hand, and wait for the environment to return to Ready.

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

For whoever runs this root for the first time, with the tools and credentials this repository's container lacks. Each step names what confirms the root and what refutes it; record what was found in [Provenance](#provenance), and fix the root rather than the expectation where they disagree. The 2026-09-22 and 2026-09-23 runs completed every step; the steps stand for adopting the live resources into a fresh state.

1. **Syntax and references.** `tofu init -backend=false && tofu validate`. Confirmed by `Success! The configuration is valid.` Refuted by any error. The 2026-09-22 run passed it.
2. **Provider lock.** `tofu init -backend-config=backend.hcl`, then commit `.terraform.lock.hcl`. Confirmed by an init that resolves `hashicorp/aws` 6.x and `cloudflare/cloudflare` 5.x and a lock file naming both.
3. **Adoption.** Every `tofu import` above ends in `Import successful!`. A zone-setting import that fails with `403` means the token lacks Zone Settings Read ([State and credentials](#state-and-credentials)).
4. **The recorded values are the live ones.** `tofu plan`, before anything else changes. Confirmed when the only changes are the ones this root makes by design: on each environment, the `DisableDefaultEC2SecurityGroup` and `SecurityGroups` settings, plus the other declared settings the provider has not recorded in state before (an in-place update on the `setting` set, with values matching the committed files); on the group, any range Cloudflare has published or withdrawn since 2026-09-17. Refuted by a zone setting, a record's `proxied` or `content`, the group's egress, a tag, or a declared option value that differs from `docs/DEPLOYMENT.md` and the committed files: the root or the record is wrong, and which one is the question to settle before applying.
5. **The inbound posture.** Check that nothing else uses either platform group ([Before an apply that changes an environment's security groups](#before-an-apply-that-changes-an-environments-security-groups)). Apply staging, then run `aws ec2 describe-security-groups` on every group the staging instance attaches (`aws ec2 describe-instances` names them). Confirmed when it attaches exactly one group, the one in state as `aws_security_group.origin`, whose inbound list is one rule, `tcp/443`, from the ranges the plan read, and when the staging public name answers `200` over HTTPS. Refuted by a second group, any other inbound rule, or a health status other than Ok.
6. **The posture survives a rebuild.** `aws elasticbeanstalk rebuild-environment` on staging, then step 5 again, and `tofu plan -detailed-exitcode` exits `0`. Then production, by the same steps. Record the date and the operation here and in [the saved-configuration README](../../apps/web/deploy/aws_eb_saved_configurations/README.md#the-verification-this-directory-still-needs).
7. **The edge.** `curl -sI http://<public name>/` answers `301` to the `https://` form, and `curl -sI https://<public name>/` states `strict-transport-security: max-age=2592000` with no `includeSubDomains` or `preload`, on both names.

### What the first run found

The 2026-09-22 plan and the 2026-09-23 apply ([Provenance](#provenance)) checked the root's assumptions against the live account and zone:

- **Confirmed:** OpenTofu 1.10 or later (1.12.6), and the S3 backend with `use_lockfile`, which every plan and apply of the 2026-09-23 run used.
- **Confirmed:** the Cloudflare provider's v5 schema. In 5.25.0, the `cloudflare_ip_ranges` data source exposes `ipv4_cidrs` and `ipv6_cidrs`, `cloudflare_zone_setting` takes `setting_id` and `value`, and `cloudflare_dns_record` requires `ttl`. The HSTS `security_header` value as a `strict_transport_security` object imported with no difference, and the zone-setting import id is `<zone-id>/<setting_id>`.
- **Confirmed:** the zone settings. SSL/TLS mode `strict`, Always Use HTTPS on, and HSTS with `max-age=2592000`, no `includeSubDomains`, no preload and `nosniff` `false` all imported with no difference, and the ranges the data source read are the ones the group admits.
- **Confirmed, with a correction:** each public name is a proxied `CNAME` to its environment's Elastic Beanstalk name, with automatic TTL. Elastic Beanstalk reports one environment's name in mixed case while the record holds it lowercase, so `cloudflare.tf` lowercases the content, and both imported records plan with no change.
- **Confirmed:** every option value the root declares matches the live one, on both environments, except `DisableDefaultEC2SecurityGroup` and `SecurityGroups`, which this root changes by design; and `DisableDefaultEC2SecurityGroup` is an option the live platform version offers.
- **Confirmed:** each environment's `description` in `terraform.tfvars` matches the live one. The root passes it as given, so an apply clears or replaces a live one that differs: copy each from `aws elasticbeanstalk describe-environments --environment-names <name> --query 'Environments[0].Description'` before a first plan against a fresh state.
- **Confirmed:** the platform-set tags on the environments show as no difference.
- **Confirmed:** the provider compares only the declared `setting` blocks. An import records no settings in state, so the first plan lists every declared setting as an addition; a plan after the apply is empty. The options the platform stores with a resource name (`ResourceName` in the committed files), 14 of which overlap the declared settings, show no perpetual difference.
- **Confirmed:** the group's egress is the single allow-all IPv4 rule.
- **Confirmed:** a single-instance environment accepts `DisableDefaultEC2SecurityGroup = true` with one group in `SecurityGroups`. The update replaces the instance and deletes the platform's group with the stack update, and a `rebuild-environment` afterwards creates no platform group. The deletion fails while anything else uses that group ([Before an apply that changes an environment's security groups](#before-an-apply-that-changes-an-environments-security-groups)).
- **Refuted, and declared:** the group carries a `Name` tag, which the plan proposed removing. `security_group.tf` declares it.
- **Refuted, and declared:** changing the rule description is not a change to the rule alone. The plan replaces the whole inline ingress block, removing the rule and adding it back, inside an in-place update of the group. `security_group.tf` declares the live description, so an apply does not rewrite the rule.
- **Not measured:** which of revoke and authorize the provider calls first when the ingress block is replaced -- by a description change or a change in the rule's ranges. No apply so far changed the rule. A revoke first drops requests from the edge, or from a range being replaced, for the seconds between the two calls.
- **Not measured:** whether the posture holds through a managed platform update.

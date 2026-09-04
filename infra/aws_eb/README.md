# AWS Elastic Beanstalk environment provisioning

Terraform for creating the AWS Elastic Beanstalk environment the web application
is deployed to: a VPC with one public subnet, an internet gateway and route
table, a security group opening HTTP and HTTPS, the Elastic Beanstalk service and
instance IAM roles, an SNS topic for environment health notifications, and the
Elastic Beanstalk application and environment themselves.

Nothing in the repository runs it -- no workflow, script, or package manifest
invokes Terraform. The deploy workflow
([`.github/workflows/eb_deploy.yaml`](../../.github/workflows/eb_deploy.yaml))
pushes a new application version to an environment that already exists; creating
that environment is not automated here.

It is a draft rather than a description of what is deployed. The environment's
solution stack and VPC id are written as bare identifiers (`node_js_ss`,
`vpc.id`) instead of references to the data source and the resource that define
them, and the public subnet is never associated with the route table. Read it as
an inventory of the resources an environment needs, and finish and validate it
before running it against an account.

Not to be confused with
[`apps/web/deploy/aws_eb/`](../../apps/web/deploy/aws_eb/), the deployment
payload -- a `Procfile`, the `.platform` nginx configuration, and the platform
hooks that install the certificate that configuration serves -- that the build
workflow copies into the bundle it ships. That directory is what the deploy path
consumes; this one stands outside it.

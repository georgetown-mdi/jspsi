import { describeHookTreeParity } from "./lib/hookTreeParity.mjs";

// The certificate-download hook's two copies. An edit landing in one of them
// silently reintroduces the certificate-load failure the other exists to fix,
// and a copy that does not stop on a failed download leaves nginx failing
// later on a missing key with a confusing signature.

describeHookTreeParity("the EB certificate download hook's two copies", [
  "apps/web/deploy/aws_eb/.platform/hooks/prebuild/download_certificates.sh",
  "apps/web/deploy/aws_eb/.platform/confighooks/prebuild/download_certificates.sh",
]);

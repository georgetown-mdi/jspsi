---
title: "Security Incident Response Runbook"
review_owner: "psilink maintainers"
last_reviewed: "2026-08-15"
---

# Security incident response runbook

This is the responder's side of [SECURITY.md](../SECURITY.md), in the order the work happens: from a report arriving to an advisory published. SECURITY.md is what a reporter reads -- scope, timelines, and disclosure terms -- and it is the authority on all three; this document sequences the work behind it for someone doing it under time pressure.

Where a step already has a home, this runbook points at it instead of repeating it: release mechanics are in [RELEASES.md](RELEASES.md), the threat model and control descriptions in [SECURITY_DESIGN.md](SECURITY_DESIGN.md).

Two roles appear throughout:

- **The maintainer** holds commit access, the release signing key, and the registry credentials, and does the technical work.
- **The co-owner** is the organization's other owner. When the maintainer is unavailable, the co-owner covers intake and reporter communication and does not attempt the fix; see [When the maintainer is unavailable](#when-the-maintainer-is-unavailable).

A leaked shared secret between two exchange partners is a different event with a different reader: the operator-side procedure for that is [SECURITY_DESIGN.md#compromise-response](SECURITY_DESIGN.md#compromise-response), which the partners run themselves and which needs nothing from this project.

## Preconditions

Confirm these once a year alongside the [tabletop exercise](#exercise-record). Each one is otherwise discovered missing at the worst moment.

**The intake path is open.** [SECURITY.md](../SECURITY.md#reporting-a-vulnerability) names GitHub private vulnerability reporting as the primary way in and the maintainer's email as the fallback for a reporter who cannot use it. A report arriving by email lands in one mailbox rather than the private thread, so open a draft security advisory for it on receipt and continue there. The GitHub path is a repository setting:

```sh
gh api repos/georgetown-mdi/jspsi/private-vulnerability-reporting
```

`{"enabled":true}` is the answer this runbook depends on. Enable it in the repository's security settings if the check answers otherwise; the API answer is the check that stays true as setting names move.

**Release credentials are reachable.** Shipping a hotfix needs the maintainer's SSH signing key ([RELEASES.md#source-integrity](RELEASES.md#source-integrity)) and the `DOCKER_USERNAME` and `DOCKER_TOKEN` repository secrets ([RELEASES.md](RELEASES.md#8-build-and-publish-the-container-image-ci)). Both are single-custody, which is why the maintainer-unavailable path below is a communication playbook rather than a release one.

**Someone besides the maintainer sees a report arrive.** Confirm the co-owner holds an account with admin access to the repository and that its security notifications reach them.

## 1. Receive and acknowledge

Target: within 5 business days ([SECURITY.md#response-timeline](../SECURITY.md#response-timeline)).

- Reply in the private report thread. Acknowledge receipt, state that a triage verdict follows within 15 business days, and ask for anything missing from the reporter checklist in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability): affected component, version, transport channel, and a reproduction.
- Keep it private. No public issue, no pushed branch, and no commit message, pull-request title, or CHANGELOG line naming the mechanism before the advisory publishes. This repository is public and its history does not redact.
- Keep the dates in the report thread as you go: received, acknowledged, confirmed or declined, fix merged, release published, advisory published. These are what an assessment asks for afterwards, and reconstructing them later is harder than writing them down.
- Set two reminders from the confirmation date: one at 90 days, the published fix-or-advisory target, and one two weeks ahead of it.

## 2. Triage and call severity

Target: confirmed or declined within 15 business days.

Reproduce before deciding anything. If the report is not reproducible, say so in the thread and ask for the missing conditions rather than declining silently -- the clock is on the verdict, not on certainty.

**Is it in scope?** [SECURITY.md#scope](../SECURITY.md#scope) lists what is in and what is out. A flaw in the PSI primitive itself goes upstream to OpenMined/PSI, with a note back to us so the vendored copy gets updated. Declining is a legitimate verdict and gets the same care as confirming: name the scope line it falls outside, and where the reporter should take it instead. One caveat when reading that list: it is a reporter-facing summary rather than the boundary of what gets fixed, so a report describing a real defect in a control this project documents is triaged even when the list does not name that control, and the scope question goes to the maintainer rather than to the reporter as a decline.

**How severe?** Anchor the call in what psilink claims:

- **Critical or High** -- a result revealing more than the agreed intersection, authentication bypass or partner impersonation, shared-secret or key-file exposure, or record data exposed in plaintext on a path documented as confidential.
- **Moderate** -- a documented control that fails open without being fully bypassed, or an exposure that needs an unlikely configuration.
- **Low** -- disclosure of non-record metadata, or a denial of service against a party's own run.

Two design facts settle a recurring class of report before it consumes a week. Zero-setup exchanges have no application-layer AEAD by design and rely on transport encryption alone ([SECURITY_DESIGN.md#channel-security](SECURITY_DESIGN.md#channel-security)), and an adversary who has already compromised the host running psilink is out of scope. A report resting on either is a documented limitation; say which one, explicitly, when declining on that basis.

Score the severity with CVSS in the draft advisory (step 5) rather than in the thread, so the number the reporter is told and the number that publishes are the same one.

## 3. Determine affected versions

Patches cover the current major release and the previous major ([SECURITY.md#supported-versions](../SECURITY.md#supported-versions)). Applying that rule to a concrete report:

- Released versions are the signed `vX.Y.Z` tags, not `staging`. Check the flaw against the tag:

  ```sh
  git fetch --tags
  git tag --list 'v*'
  git log --oneline vX.Y.Z -- <path of the affected file>
  ```

- A flaw that exists only on `staging` and in no tag needs a fix, not an advisory: no released artifact contains it. Tell the reporter that is the verdict and that the fix ships with the next release.
- While the released line is `0.x`, there is no previous major to patch. The current release is the only supported version, and the previous-major row starts binding at 1.0. An empty row is not a claim that older releases are covered.
- Write down the affected range and the fixing version as soon as they are known. Both go into the advisory verbatim, and into the reporter's next update.

## 4. Fix privately, then release

The release mechanics are [RELEASES.md#hotfix-releases](RELEASES.md#hotfix-releases): branch from the affected release tag, one minimal focused commit, then the ordinary release checklist with a PATCH bump. Follow it as written. What it does not cover, and what this step adds, is the disclosure sequencing around it.

- Develop out of public view: GitHub's temporary private fork from the report thread, or a local branch. Do not push the branch to the public repository.
- Write a regression test that fails without the fix. A security fix that ships without one is how the same flaw comes back.
- **Opening the pull request is the disclosure.** A fix diff on a public repository tells anyone reading it what the flaw was, whatever the PR text says. Open it when you are ready to merge, tag, release, and publish the advisory in one sitting -- not days ahead of the release.
- Until the advisory publishes, the pull request body and the commit message describe the fix, not the attack.
- The CHANGELOG entry goes in a `### Security` subsection ([RELEASES.md#3-update-changelogmd](RELEASES.md#3-update-changelogmd)). It names the impact and the fixed version, and it can be written at publication time rather than in the private fork.
- If a supported previous major is affected, apply the fix there too before publishing anything ([RELEASES.md#hotfix-releases](RELEASES.md#hotfix-releases), step 4).
- A security release skips none of the ordinary gates: the [image vulnerability scan](RELEASES.md#image-vulnerability-scan) still gates the push, and the release still produces a signed image, a provenance attestation, and an SBOM.

## 5. Draft the advisory and request a CVE

The advisory and the CVE both run through the repository's Security tab, under Advisories. GitHub is a CNA, so the CVE request goes there and nowhere else.

1. **Draft it from the report.** Starting the draft from the private report thread keeps the reporter attached to it, which is what keeps the credit attached through to publication.
2. **Fill in the substance**: a title naming the component and the impact; a description covering impact, affected versions, the fixed version, and a workaround for anyone who cannot upgrade immediately; the CVSS vector; and a CWE if one fits.
3. **Affected products.** That section is built around package ecosystems, and psilink publishes no registry package -- the released artifacts are a signed container image and the tagged source ([RELEASES.md#release-artifacts](RELEASES.md#release-artifacts)). Put the affected and fixed versions in the description as well, where they are readable regardless of what the form accepts. This project has not yet driven that form against a real advisory, so treat this paragraph as a starting point to confirm at first use rather than as tested guidance, and correct it here afterwards.
4. **Request the CVE ID** from the draft before publishing. The identifier is assigned to the draft and travels with it to publication.
5. **Credit the reporter** by the name or handle they use, unless they asked for anonymity ([SECURITY.md#disclosure-policy](../SECURITY.md#disclosure-policy)).
6. **Share the draft with the reporter** for accuracy before publishing. They usually catch an overstated or understated impact.
7. **Publish once the patched release is downloadable.** An advisory ahead of its fix is a disclosure with no remedy attached.

## 6. Reporter communication

Every milestone below is a message the reporter should not have to ask for.

| Milestone            | Target                        | What the reporter is told                                                     |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| Acknowledgement      | 5 business days from receipt  | The report arrived, who is handling it, and when the verdict follows           |
| Triage verdict       | 15 business days from receipt | Confirmed or declined, with the severity call, or the scope line behind a decline |
| Fix plan             | With the verdict, if confirmed | The affected versions, the intended fixing version, and a target date          |
| Slip                 | Before the date passes         | The new date and the reason, said early rather than explained late            |
| Draft advisory       | Before publication            | The text, the credit line as it will read, and a chance to correct both        |
| Publication          | Same day                      | The advisory link, the CVE, and the released version with the fix          |

The 90-day window in [SECURITY.md](../SECURITY.md#response-timeline) runs from confirmation, and reporters are asked to hold disclosure until the advisory or that date, whichever is first. If the window is going to be missed, raise it well before it elapses and agree what happens next -- an early conversation keeps a coordinated disclosure coordinated.

## 7. Close out

- Confirm the published state: advisory live with its CVE, release notes and CHANGELOG holding the security entry, patched image published and signed.
- Thank the reporter and close the thread.
- Fix whatever in this runbook fought you, in the same week, while the friction is still remembered.
- If the incident exposed a gap in a control rather than a single defect, that is follow-up work in its own right; raise it with the maintainer rather than leaving it in the closed thread.

## When the maintainer is unavailable

This section is for the co-owner. All of it is communication. None of it is a release: the signing key and registry credentials are the maintainer's alone, so no fix can ship on this path, and an accurate date is worth more to a reporter than an attempted release.

In order:

1. **Acknowledge within 5 business days**, in the private thread, using the template below. Acknowledging is not confirming: it commits to nothing about whether the report is valid.
2. **Keep the report private.** Do not open an issue, do not describe it to anyone outside the organization, and do not repeat its content in any public channel.
3. **Reach the maintainer** through the routes the organization keeps for this, and get an expected return date.
4. **Tell the reporter what is actually true** as soon as the 15-business-day triage target looks unreachable: the technical owner is unavailable, here is the date they return, here is when a verdict follows. Reporters accept a delay they are told about far better than one they discover.
5. **Bring in technical help only if waiting is not viable** -- the report suggests active exploitation, or the absence will outrun the 90-day window. Use someone the organization already trusts with a private disclosure, and scope them to assessing severity, not to shipping a fix.
6. **Do not** attempt the fix, tag or publish a release, publish an advisory, or request a CVE.

Acknowledgement template:

```text
Thank you for reporting this privately, and for following our disclosure policy.

I am acknowledging receipt on behalf of the project. Our technical maintainer is
unavailable until <date>; I am not able to assess the technical detail myself, so
the triage verdict will come from them and I expect it by <date>.

The report stays private with us in the meantime. If anything changes on your end
-- including evidence that the issue is being exploited -- please tell me here and
I will escalate immediately.
```

## Exercise record

This runbook is walked once a year against a simulated report, and again after any change to the release or disclosure process that would alter the sequence. The annual cadence exists so that an assessment asking whether a plan exists and whether it was tested has one dated answer to both. The exercise's value is the gaps it finds: each is fixed here, or referred to the maintainer when the fix is not a documentation change.

| Date       | Scenario                                                            | Result                                              |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| 2026-08-15 | Simulated high-severity at-rest exposure report against a release   | 7 findings: 3 fixed here, 4 referred to the maintainer |

### 2026-08-15

**Scenario (simulated).** A researcher privately reports that on Windows the CLI writes the result CSV with an inherited ACL granting a second local account read access, so any user of that machine can read the linked records. This scenario is invented for the exercise and describes no defect in psilink: the owner-only write path it imagines failing is specified in [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md). It was chosen because it is confirmable, platform-scoped, and severe enough to reach publication, so the walk covers every step rather than ending at a decline.

**Walked.** Steps 1 through 7 in order, against the repository as it stood on the exercise date: intake and acknowledgement, the severity call (High -- record data readable by a non-owner on the same host), affected versions (`v0.1.0`, the only signed release tag; no previous major exists on a `0.x` line), the hotfix path (branch from `v0.1.0`, fix, `v0.1.1`), advisory drafting and CVE request, and the reporter messages at each milestone.

**Findings fixed in this runbook:**

1. The supported-version rule does not resolve on a pre-1.0 line: with only `0.x` released, the previous-major row is empty and reads either as "nothing is supported" or as "everything older is". Step 3 states how to apply the rule until 1.0.
2. Following the hotfix procedure literally opens a public pull request with the fix diff, potentially days before the advisory publishes. The procedure is about mechanics and says nothing about when the fix becomes public. Step 4 states the sequencing, and the hotfix section points at it.
3. The advisory form's affected-products fields assume a package ecosystem, and this project publishes none, so an advisory drafted from it can end up without a machine-readable affected range. Step 5 records putting the versions in the description, and marks the form's behavior as unconfirmed until a real advisory is drafted.

**Findings referred to the maintainer:**

4. GitHub private vulnerability reporting -- the only intake path SECURITY.md names -- read as disabled when checked on the exercise date, so a reporter following the policy would find no way to file. The precondition check above exists so this is caught yearly rather than by a reporter.
5. No fallback intake channel is published anywhere in the repository. A reporter who cannot use the GitHub path, or who arrives while it is off, has nowhere to go but a public issue.
6. The release signing key and the registry credentials are single-custody. That is what makes the maintainer-unavailable path communication-only, and whether it is accepted or mitigated is a decision for the owners rather than for this runbook.
7. The scope list in SECURITY.md covers the protocol, transport confidentiality, and credential parsing, but not the at-rest permissions of the artifacts psilink writes -- the very class this exercise simulated. The interim reading is in step 2; whether the published list should name it is the maintainer's call.

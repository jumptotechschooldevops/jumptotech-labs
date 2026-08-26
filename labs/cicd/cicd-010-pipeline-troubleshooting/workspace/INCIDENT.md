# INC-2291 — statements pipeline has not run since Thursday

**Reported by:** release management
**Severity:** blocking the 1.4.1 release

## What we know

A contractor "tidied up" the CI configuration on Thursday afternoon and left
that evening. Since then:

- The GitHub Actions tab shows **no runs at all** for this repository. Not
  failed runs — no runs. The last one recorded is from Wednesday.
- The Jenkins job for the batch pipeline fails immediately, before any stage
  starts. The console output complains about the pipeline definition rather
  than about anything the pipeline does.
- The last person who tried building locally said "the tests were already
  failing before I touched anything".

## What the pipeline is supposed to do

Both pipelines existed and worked on Wednesday. The agreed shape has not
changed:

**GitHub Actions**, on push, one `build` job on `ubuntu-latest`:

1. check the repository out
2. provision the Node.js toolchain
3. run the build
4. run the tests
5. upload the build output as an artifact, named using `APP_VERSION`

**Jenkins**, a declarative pipeline: `Checkout`, `Build`, `Test`, `Package`.

## Notes from the on-call handover

> Do not rewrite these from scratch. Whatever was changed is small, and we want
> to know what it was — the same mistake will be made again otherwise.

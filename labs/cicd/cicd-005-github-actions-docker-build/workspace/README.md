# jumptotech-statements

The statement formatting service for JumpToTech Bank. It turns a list of
transactions into the plain-text statement customers download from the online
banking portal.

It has **no dependencies**. That is deliberate: these labs are about the
pipeline, not about the application, so nothing here needs a package registry
and nothing you do in this workspace reaches the network.

## Running it by hand

```sh
node src/cli.mjs              # print a sample statement
node src/cli.mjs --selftest   # end-to-end self-check; exit code 0 means healthy
```

## The three commands a pipeline cares about

| Stage | Command                       | What it proves                         |
| ----- | ----------------------------- | -------------------------------------- |
| Build | `node build.mjs`              | source turns into `dist/` artifacts    |
| Test  | `node --test`                 | the library still behaves as specified |
| Smoke | `node src/cli.mjs --selftest` | the built thing actually runs          |

## Layout

```
build.mjs                 the build: src/ -> dist/
package.json              name, version, and the scripts above
src/statements.mjs        the library — no imports, so it can be bundled
src/cli.mjs               command line and self-check
test/statements.test.mjs  tests, using the Node.js built-in runner
```

`dist/` is generated. It is not in version control, which is exactly why a
pipeline has to build it.

# N18 — offline image delivery into a session's Docker daemon

**Status:** DESIGNED → IMPLEMENTED (see §7). This document was written before
the code, and records the investigation that decided it.

---

## 1. What N18 is

A Docker lab declares the images it needs in `setup.docker.images`. Today the
provider obtains each one with `#ensureImage`:

```ts
if (await session.inspectImage(reference)) return;
await session.pullImage(reference);          // ← a registry fetch
```

So **every Docker lab start depends on a registry**, from inside the sandbox,
at the moment a student clicks Start. N18 is the capability to put a lab's
images into the session's daemon **without a network fetch**, deterministically,
on both create and reset.

It is a platform capability, not a lab workaround: it applies to every image in
`setup.docker.images` that the platform chooses to ship, which today means the
three images the whole Docker track already uses.

### What N18 is not

- **Not privilege.** Loading an image grants nothing. A container that needs
  `NET_ADMIN` to *apply* firewall or NAT rules at seed time needs N19, which is a
  separate security decision — see `n19-security-review.md`.
- **Not NET-010.** An earlier run recorded NET-010 as blocked on N18. It was not:
  `busybox:1.36` already carries `udhcpd`. NET-010 shipped without N18.

---

## 2. Investigation — the architecture as it actually is

| Question | Answer, from the code and measurement |
|---|---|
| Which process owns `/var/lib/docker`? | The `dockerd` inside the sandbox container. The sandbox is the *host* from the student's point of view. |
| What backs it? | A per-session named volume, `${sandbox}-data`, created by `#createSandbox` and labelled with the session id and `MANAGED_LABEL`. |
| When is it mounted? | At sandbox creation, before `dockerd` starts. |
| When does "masking" occur? | **It does not.** See §3.1. |
| What can the student observe? | Their own daemon's image store, over TLS. A student **can `docker rmi`** any image, including one the lab depends on. |
| What can the verifier observe? | `docker_image_exists` against the same session daemon. |
| Can one session affect another? | No, structurally: one volume, one daemon, one sandbox per session. |
| Can reset leave stale state? | Reset re-runs `#applySetup`, so it re-ensures images. Today that means a re-*pull* of anything the student deleted. |
| Security or determinism problem? | **Determinism**, primarily — and an egress dependency on the path of every lab start. |

### The provider sequence

```text
create():  network → sandbox container → #waitForDaemon (docker info)
           → #applySetup → #ensureImage per image → networks → files → containers
reset():   remove student state → #applySetup (same as above)
```

`#ensureImage` runs **after** the readiness gate and **before** any container
that uses the image, on **both** paths.

---

## 3. What was measured before designing

Every claim below was reproduced on Docker Engine 28.4.0 with the shipped
`jumptotech/lab-docker` sandbox image, on 2026-09-16.

### 3.1 The "masking race" an earlier document described is not real

An earlier entry in the curriculum claimed the fresh `/var/lib/docker` volume
*masks* anything the image pre-populated there. Tested with a file written into
`/var/lib/docker` in an image, then run three ways:

| | Result |
|---|---|
| fresh **empty** named volume at `/var/lib/docker` | file **visible** |
| no volume (control) | file visible |
| the same volume on a second run | file still there |

Docker **copies** an image's content into an empty named volume on first mount.
Nothing is masked. The earlier claim is corrected in the curriculum.

### 3.2 Pre-baking an image store into the sandbox image does not work

The most elegant design would be: ship a populated `/var/lib/docker` in the
sandbox image, let the copy-on-first-mount in §3.1 put it in every session's
volume, and have no runtime step at all. Tested by running the sandbox with no
volume, pulling `busybox:1.36`, stopping cleanly and `docker commit`-ing:

```
docker image inspect … --format '{{json .Config.Volumes}}'
{"/var/lib/docker":{}}
```

`docker:dind` **declares `VOLUME /var/lib/docker`**. The committed image's store
was 4.0K and empty, and a session started from it had no images. `docker commit`
never captures volume content. Producing a populated store any other way means
running `dockerd` inside `docker build`, which needs a privileged build — not
something this repository's build pipeline has, and not something to add for
this.

**Rejected.**

### 3.3 The race that *is* real

The remaining obvious design is a loader in the sandbox's **entrypoint**: start
`dockerd`, wait for it, `docker load` the tarballs. Reproduced with a real
4.3MB tarball, polling `docker info` exactly as `#waitForDaemon` does:

| Sampled at | images | loaded |
|---|---|---|
| the instant `docker info` first succeeds | **0** | no |
| after the loader finishes | 1 | yes |

The provider's readiness gate passes **while the store is still empty**.
`#ensureImage` would then see no image and **pull** — reintroducing the registry
dependency N18 exists to remove, or failing outright offline. It is a genuine
race, because the loader and the provider are two independent actors with
nothing sequencing them.

**Rejected.** A regression test (`docker-baked-images.test.ts`) pins the
property that removes it.

---

## 4. Designs compared

| | Design | Offline | Race-free | New broker surface | Verdict |
|---|---|---|---|---|---|
| A | **Tarballs baked into the sandbox image; the provider loads one inside `#ensureImage`** | yes | **yes — provider-sequenced** | one typed op, no argv | **chosen** |
| B | Pre-populated `/var/lib/docker` in the image | yes | yes | none | not buildable (§3.2) |
| C | Entrypoint loader | yes | **no** (§3.3) | none | rejected |
| D | Registry mirror (`DOCKER_SANDBOX_REGISTRY_MIRROR`) | only with a separately-run registry | yes | none | complementary, not a substitute: it moves the fetch, it does not remove it |
| E | Pull a third-party tooling image | no | yes | none | supply chain + egress; the problem, not a solution |

### Why A

1. **Race-free by construction.** The load happens inside `#ensureImage`, which
   the provider calls after `#waitForDaemon` and before any container is created.
   There is one actor, so there is nothing to race.
2. **Reset-safe for free.** `reset()` re-runs `#applySetup`, so a student who
   `docker rmi`'d a lab's image gets it back from the baked copy, offline, with no
   separate reset logic.
3. **It is the Terraform mirror's pattern.** The Terraform sandbox bakes a
   provider mirror into its image so `terraform init` needs no registry. This
   bakes image archives into the Docker sandbox image so `setup.docker.images`
   needs none.
4. **Buildable without privilege.** `sandbox-build.sh` runs on the host, which
   has a daemon: it `docker save`s each image into the build context *before*
   `docker build`, and the Dockerfile `COPY`s the archives in. No `dockerd` in the
   build.

---

## 5. Design A in detail

### 5.1 The manifest — a closed list, compiled in

```ts
// services/lab-orchestrator/src/docker/baked-images.ts
export const BAKED_IMAGES = {
  'busybox:1.36':       'busybox-1.36.tar',
  'alpine:3.20':        'alpine-3.20.tar',
  'nginx:1.27-alpine':  'nginx-1.27-alpine.tar',
} as const;
export const BAKED_IMAGE_DIR = '/opt/jumptotech/images';
```

A lab never names a path. It names an image reference it already names today,
and the path is **looked up** in a closed map. A reference that is not in the map
has no baked copy and behaves exactly as today.

### 5.2 The port

```ts
/** Load a platform-shipped image archive into this daemon, by reference. */
loadBakedImage(reference: string): Promise<'loaded' | 'not-baked'>;
```

Takes a **reference**, not a path. Returns `'not-baked'` for a reference outside
the manifest — which is an answer, not an error.

### 5.3 The three implementations

| Engine | How |
|---|---|
| CLI session engine | resolves reference → file from the manifest, then `docker load -i <BAKED_IMAGE_DIR>/<file>` through the same `docker exec <sandbox> docker` prefix every session call uses |
| Broker session engine | `sessionLoadBakedImage { sessionId, reference }` — **no path on the wire** |
| sandboxd | re-validates the reference against the manifest itself, then calls the session engine |

### 5.4 `#ensureImage`

```ts
if (await session.inspectImage(reference)) return;
const baked = await session.loadBakedImage(reference);
if (baked === 'loaded') {
  // Fail closed: a baked archive that loads but does not produce the image is
  // a broken sandbox image, and pulling instead would hide it.
  if (!(await session.inspectImage(reference))) throw new DockerSetupError(…);
  return;
}
await session.pullImage(reference);   // unchanged for anything not baked
```

### 5.5 Failure behaviour — fail closed

| Situation | Behaviour |
|---|---|
| reference not in the manifest | `'not-baked'` → pull, exactly as today |
| in the manifest, archive loads, image present | done, no fetch |
| in the manifest, **archive missing** from the sandbox image | `docker load` fails → **setup fails**. Never silently pulls: a sandbox image built without its archives is a build defect, and a pull would hide it until the day there was no network. |
| in the manifest, load "succeeds" but image absent | **setup fails** |
| reference not a valid image reference | refused by the manifest lookup before anything runs |

---

## 6. Security analysis

| Concern | Why it holds |
|---|---|
| Arbitrary file load | No path crosses any boundary. The path is `BAKED_IMAGE_DIR` + a filename from a compiled-in map, joined in trusted code. |
| Path traversal | Filenames are literals in the map; a test asserts each is a bare basename matching `^[a-z0-9][a-z0-9.-]*\.tar$`. |
| Command injection | argv array, `docker load -i <fixed path>`, no shell. |
| Host Docker socket | Untouched. The load runs in the **session** daemon, reached the way every session call already is. |
| Host filesystem | The archives live in the *sandbox image*; nothing reads the host. |
| Cross-session | One daemon per session; the broker op is keyed on `sessionId` through `#ownedSandbox`. |
| Privilege | Loading an image grants no capability. The sandbox's existing `--privileged` is unchanged. |
| A student deleting a baked image | Restored on reset, offline — the reset path re-runs `#ensureImage`. |
| A student replacing a baked image | A student can `docker tag` any image as `busybox:1.36`. `#ensureImage` then sees it present and does not reload. That is **not new**: it is true of a pulled image today, and a lab that grades an image pins it with `docker_image_exists`/`docker_container_image`. Recorded as a known limitation rather than hidden. |
| Resource exhaustion | Archives are fixed at image build time (~26MB for the three images); a lab cannot add one. |
| Supply chain | The archives are `docker save` output of the same pinned references the labs already name, produced by the operator's build, not fetched at lab time. |

---

## 7. Implementation status

See the run report, `networking-wave2-autonomous-run.md`, for commits, tests and
the real-daemon validation.

## 8. What N18 does not unblock on its own

NET-011 and NET-019 both seed a container that must **apply** network state at
start — an nftables rule set that drops a port, or NAT rules and IP forwarding.
That needs `NET_ADMIN` on a *seeded* container, which `setup.docker` cannot
express. That is N19, and it is reviewed separately.

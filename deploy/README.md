# Deployment workflow

Production was not changed while creating this repository. The old source
directory `/home/deploy/evolution-group-mentions` remains frozen until a later
validated migration.

## Intended future flow

```text
LOCAL
  change → test → commit → push → immutable tag

VPS
  fetch → checkout tag/commit → disk precheck → build → image tag
  → deploy → smoke test → rollback if necessary
```

Every release should have an immutable image tag, for example:

```text
evolution-api:rwhub-v2.3.7-1
```

Moving aliases such as `production` and `rollback` may be used only as pointers
to already-built immutable images. A deployment must keep the previous image
available before changing the production pointer.

The future VPS checkout should be `/home/deploy/evolution-api-custom`. It must
be created alongside, not in place of, `/home/deploy/evolution-group-mentions`
until the new image has been built and compared with the running production
image.

No deployment, Portainer update, container restart, volume change or session
migration is part of this baseline.

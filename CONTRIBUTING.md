# Contributing to ReoLook

Thanks for looking. ReoLook is a small project, so a short note beats a long process.

## Before you start

- **Bugs and questions:** open an issue. Include your camera model and firmware version, the output
  of `node bin/reolook.mjs capabilities --host IP` (if the problem is about a camera feature), what
  you did, what you expected and what happened. **Remove camera passwords, addresses and
  recordings from anything you post.**
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first, so we can agree on the idea before you write the code.

## Setting up

You need Linux, Node.js 22 or newer, and `ffmpeg` with `ffprobe`. There is nothing to install:
ReoLook has no dependencies, and a change should not add one.

```sh
git clone https://github.com/chevybowtie/ReoLook.git && cd ReoLook
npm test                      # about 480 tests, 12 seconds
node bin/reolook.mjs demo     # the whole interface with four simulated cameras, no hardware
```

The tests need no cameras and change nothing on your system. They run real ffmpeg for recording,
remux and export, and use a fake Reolink camera (`test/support/fake-camera.mjs`) and a command-line
sandbox (`test/support/cli-sandbox.mjs`) for everything else.

## How the code is written

- **Plain ES modules** (`.mjs`), no build step, no dependencies. `public/index.html` is the whole
  interface, with no framework.
- **Every function has a comment** saying what it does, what it takes and what it returns. Keep
  functions to one job each.
- **Match what is there:** naming, spacing, and the way errors are reported. `README.md` has a table of what
  lives where.
- **Tests come with the change.** A bug fix gets a test that fails without the fix. Use the fake
  camera rather than a real one, and avoid fixed sleeps where an event or a short poll will do.
- **Speed matters, but measure first.** Say what you measured before and after. Camera reads are
  deliberately limited in how many run at once (`src/concurrency.mjs`): a camera is a small device.
- **Cameras are touched carefully.** Anything that writes to a device goes through the plan,
  confirm, apply, verify and undo pipeline (`src/safe-write.mjs`); a new setting is a descriptor in
  `src/device-settings.mjs`.

## Hardware you have and I do not

The development cameras are Reolink RLC-410 models. Controls for PTZ, floodlight, siren, battery
and AI detection are written to Reolink's documentation but have not been tried on a camera that
has them, and `TODO.md` lists what else is unverified. Reports from other models, saying what
worked and what did not, are the most useful contribution there is.

## Sending a pull request

1. Branch from the latest `master`, and keep the change to one thing.
2. Run `npm test`; all of it must pass.
3. If behaviour changes, update `README.md` (and `docs/roadmap.md` or `TODO.md` where they apply)
   in the same change, and add a line under *Unreleased* in [CHANGELOG.md](CHANGELOG.md).
4. In the description, say what changed and why, and how you checked it (and on which camera
   model, if a camera was involved).

By contributing you agree that your work is released under the project's [MIT licence](LICENSE).

## Versions

The version is the `version` field of `package.json` (semantic versioning), and Settings > About
shows it. The maintainer changes it for a new build.

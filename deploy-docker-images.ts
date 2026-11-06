#!/usr/bin/env node

import { spawn } from "node:child_process"
import { version } from "./package.json" with { type: "json" }

let [major, minor, patch] = version.split(".")
if (patch === undefined) {
  patch = "0"
}

spawn(
  "docker",
  [
    "buildx",
    "build",
    "--platform", "linux/amd64,linux/arm64",
    //"--platform", "linux/amd64",
    "-t", `ghcr.io/ericerkz/kept:${major}.${minor}.${patch}`,
    "-t", `ghcr.io/ericerkz/kept:${major}.${minor}`,
    "-t", `ghcr.io/ericerkz/kept:${major}`,
    "-t", `ghcr.io/ericerkz/kept:latest`,
    "--push",
    ".",
  ],
  {
    stdio: "inherit",
    shell: true,
  },
)

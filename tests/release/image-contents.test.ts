import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const appDockerfile = "Dockerfile";
const consoleDockerfile = "deployments/self-hosted/docker/console.Dockerfile";
const entrypoint = "deployments/self-hosted/docker/entrypoint.sh";
const releaseCompose = "deployments/self-hosted/compose/compose.release.yaml";
const releaseWorkflow = ".github/workflows/release.yml";

describe("release image packaging", () => {
  it("builds application deploy roots with the exact production pnpm deploy commands", async () => {
    const dockerfile = await readFile(appDockerfile, "utf8");
    expect(dockerfile).toContain("RUN corepack pnpm --filter @qualigence/server deploy --prod /out/server");
    expect(dockerfile).toContain("RUN corepack pnpm --filter @qualigence/intelligence-worker deploy --prod /out/worker");
    expect(dockerfile).toContain("RUN corepack pnpm --filter @qualigence/admin-cli deploy --prod /out/admin");
  });

  it("copies only deploy roots into the application runtime image", async () => {
    const dockerfile = await readFile(appDockerfile, "utf8");
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:24-bookworm-slim@sha256"), dockerfile.length);
    expect(runtime).toContain("COPY --from=build --chown=node:node /out/server /app/server");
    expect(runtime).toContain("COPY --from=build --chown=node:node /out/worker /app/worker");
    expect(runtime).toContain("COPY --from=build --chown=node:node /out/admin /app/admin");
    expect(runtime).not.toContain("/workspace /app");
    expect(runtime).not.toContain("COPY --from=build --chown=node:node /workspace");
  });

  it("scrubs source, tests, maps, and TypeScript build metadata before runtime copy", async () => {
    const dockerfile = await readFile(appDockerfile, "utf8");
    expect(dockerfile).toContain("-mindepth 2 -maxdepth 2 -type d");
    expect(dockerfile).toContain("/out/*/node_modules/@qualigence/*/src");
    expect(dockerfile).toContain("-name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '*.tsbuildinfo'");
  });

  it("dispatches runtime roles from deploy roots rather than source workspace paths", async () => {
    const script = await readFile(entrypoint, "utf8");
    expect(script).toContain("node /app/server/dist/main.js");
    expect(script).toContain("node /app/worker/dist/main.js");
    expect(script).toContain("node /app/admin/dist/main.js");
    expect(script).not.toContain("/app/apps/");
  });

  it("keeps the Console runtime static and separate from the Node application image", async () => {
    const dockerfile = await readFile(consoleDockerfile, "utf8");
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM caddy:"), dockerfile.length);
    expect(runtime).toContain("COPY --from=build /workspace/apps/web-console/dist /srv");
    expect(runtime).toContain("RUN find /srv -type f -name '*.map' -delete");
    expect(runtime).not.toContain("node_modules");
    expect(runtime).not.toContain("/workspace/apps/web-console/src");
  });

  it("pins release workflow actions to full commit SHAs and least-privilege permissions", async () => {
    const workflow = await readFile(releaseWorkflow, "utf8");
    const uses = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@[a-f0-9]{40}$/);
      expect(action).not.toMatch(/@v\d/);
    }
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("group: ticket-34-release-${{ inputs.version }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("actions/artifacts?name=release-${RELEASE_VERSION}");
    expect(workflow).toContain("test \"$existing_release_artifacts\" = 0");
    expect(workflow).toContain('[[ "$RELEASE_VERSION" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9_-])?$ ]]');
    expect(workflow).toContain("if: success()");
    expect(workflow).toContain("name: release-${{ inputs.version }}");
    expect(workflow).toContain("artifacts/release/${{ inputs.version }}/release-manifest.json");
    expect(workflow).toContain("artifacts/release/${{ inputs.version }}/sbom.spdx.json");
    expect(workflow).toContain("if: failure()");
    expect(workflow).toContain("name: release-diagnostics-${{ inputs.version }}-${{ github.run_id }}");
    expect(workflow).toContain("--render-compose release-work/compose.release.rendered.yaml");
    expect(workflow).toContain("signatureFromEvidence(windowsSignatures");
    expect(workflow).toContain("signatures: manifestWindowsSignatures");
    expect(workflow).not.toContain("signedAt: new Date().toISOString()");
    expect(workflow).not.toContain("artifacts/release/${{ inputs.version }}/compose.release.rendered.yaml");
  });

  it("materializes verified Gate archives before the manifest and uploads their exact bytes", async () => {
    const workflow = await readFile(releaseWorkflow, "utf8");
    const materializeStep = workflow.indexOf("name: Materialize verified Gate archives");
    const manifestStep = workflow.indexOf("name: Generate and verify release manifest");
    const successUpload = workflow.indexOf("name: release-${{ inputs.version }}");
    expect(materializeStep).toBeGreaterThan(0);
    expect(manifestStep).toBeGreaterThan(materializeStep);
    expect(successUpload).toBeGreaterThan(manifestStep);
    expect(workflow).toContain('mkdir -p "$release_dir/gates"');
    expect(workflow).toContain('destination="$release_dir/gates/${gate}.zip"');
    expect(workflow).toContain('test ! -e "$destination"');
    expect(workflow).toContain('test "$(sha256sum "$source" | awk \'{print $1}\')" = "$(sha256sum "$destination" | awk \'{print $1}\')"');
    expect(workflow).toContain("const artifactPath = `artifacts/release/${version}/gates/${delivery.gate}.zip`");
    expect(workflow).toContain("artifactPath,");
    expect(workflow).toContain("artifacts/release/${{ inputs.version }}/gates/");
  });

  it("uses a digest-only release Compose overlay and removes build contexts", async () => {
    const compose = await readFile(releaseCompose, "utf8");
    expect(compose).toContain("${QUALIGENCE_RELEASE_APPLICATION_IMAGE:?set the digest-pinned application image}");
    expect(compose).toContain("${QUALIGENCE_RELEASE_CONSOLE_IMAGE:?set the digest-pinned Console image}");
    expect(compose).toContain("build: !reset null");
    expect(compose).not.toContain("${QUALIGENCE_IMAGE_TAG");
  });
});

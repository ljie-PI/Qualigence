import { describe, expect, it } from "vitest";
import { HealthClient } from "../../../apps/local-launcher/src/health-client.js";

describe("HealthClient HTTP readiness", () => {
  it("does not infer Runner readiness from a PID or TCP socket", async () => {
    const client = new HealthClient("1.0.0");
    await expect(client.coreHealth("127.0.0.1", 1, "/health/ready")).resolves.toMatchObject({
      status: "fail",
    });
  });
});

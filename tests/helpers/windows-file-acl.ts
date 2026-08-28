import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsAclRule {
  readonly sid: string;
  readonly access: "Allow" | "Deny";
  readonly inherited: boolean;
}

export interface WindowsFileAcl {
  readonly currentSid: string;
  readonly rules: readonly WindowsAclRule[];
}

/**
 * Reads effective explicit ACL identities using Windows SIDs, avoiding
 * localized account names. This is test support; production enforcement stays
 * in the KMS provider.
 */
export async function readWindowsFileAcl(path: string): Promise<WindowsFileAcl> {
  if (process.platform !== "win32") {
    throw new Error("WindowsAclUnavailable: Windows ACL inspection requires win32.");
  }
  const script = [
    `$path = ${JSON.stringify(path)}`,
    "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules = @(Get-Acl -LiteralPath $path | Select-Object -ExpandProperty Access | ForEach-Object {",
    "  [PSCustomObject]@{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; access = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited }",
    "})",
    "[PSCustomObject]@{ currentSid = $currentSid; rules = $rules } | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], { windowsHide: true });
  const parsed = JSON.parse(stdout) as { readonly currentSid?: unknown; readonly rules?: unknown };
  if (typeof parsed.currentSid !== "string" || !Array.isArray(parsed.rules)) {
    throw new Error("WindowsAclUnavailable: PowerShell returned an invalid ACL report.");
  }
  const rules = parsed.rules.map((rule) => {
    if (
      typeof rule !== "object" || rule === null ||
      typeof (rule as { sid?: unknown }).sid !== "string" ||
      ((rule as { access?: unknown }).access !== "Allow" && (rule as { access?: unknown }).access !== "Deny") ||
      typeof (rule as { inherited?: unknown }).inherited !== "boolean"
    ) {
      throw new Error("WindowsAclUnavailable: PowerShell returned an invalid ACL rule.");
    }
    return rule as WindowsAclRule;
  });
  return { currentSid: parsed.currentSid, rules };
}

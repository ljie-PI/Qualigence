export interface LocatorDescriptor {
  readonly kind: "role" | "text";
  readonly role: string;
  readonly name?: string;
  readonly text?: string;
}

export interface CapturedArtifact {
  readonly name: string;
  readonly mediaType: "image/png" | "application/json";
  readonly bytes: Uint8Array;
}

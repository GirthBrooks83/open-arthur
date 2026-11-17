/** Background errors are visible without logging provider payloads or credential-bearing URLs. */
export function backgroundFailure(phase: string, error: unknown) {
  console.error({
    timestamp: new Date().toISOString(),
    context: { phase },
    error: error instanceof Error ? error.name : "Background operation failed",
  });
}

/**
 * Provider failures are recorded server-side so a degraded source stays
 * diagnosable: the operation, the error name, its HTTP status (when the
 * error carries one) and the provider's own message. This record never
 * leaves the server log — clients only ever see human wording — and it
 * never includes tokens or credentials: provider API errors carry
 * neither, and nothing else about the request is attached here.
 */
export function providerFailure(operation: string, error: unknown) {
  const status =
    error !== null && typeof error === "object" && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  console.error({
    timestamp: new Date().toISOString(),
    context: { operation },
    error: error instanceof Error ? error.name : "Provider request failed",
    status: typeof status === "number" ? status : undefined,
    message: error instanceof Error ? error.message : undefined,
  });
}

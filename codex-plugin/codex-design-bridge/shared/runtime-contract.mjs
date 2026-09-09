export const CDB_PUBLIC_VERSION = "0.9.0";
export const CDB_EXACT_BUILD = "0.9.0+codex.20260829100031";
export const CDB_BRIDGE_PROTOCOL_VERSION = 16;
export const CDB_PAGE_IR_SCHEMA_VERSION = 2;
export const CDB_RUNTIME_IDENTITY = "cdb-0.9-responsive-v2";

export function validateExactRuntimeIdentity(value, expectedExactBuild = CDB_EXACT_BUILD) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw identityError("runtime identity is required");
  }
  if (value.kind !== CDB_RUNTIME_IDENTITY) {
    throw identityError("legacy or unknown runtime identity is rejected");
  }
  if (value.protocolVersion !== CDB_BRIDGE_PROTOCOL_VERSION) {
    throw identityError(`protocol ${CDB_BRIDGE_PROTOCOL_VERSION} is required`);
  }
  if (value.pageIrSchemaVersion !== CDB_PAGE_IR_SCHEMA_VERSION) {
    throw identityError(`Page IR schema ${CDB_PAGE_IR_SCHEMA_VERSION} is required`);
  }
  if (value.exactBuild !== expectedExactBuild) {
    throw identityError(`exact build ${expectedExactBuild} is required`);
  }
  return {
    kind: CDB_RUNTIME_IDENTITY,
    protocolVersion: CDB_BRIDGE_PROTOCOL_VERSION,
    pageIrSchemaVersion: CDB_PAGE_IR_SCHEMA_VERSION,
    exactBuild: expectedExactBuild,
  };
}

export function currentRuntimeIdentity(exactBuild = CDB_EXACT_BUILD) {
  return validateExactRuntimeIdentity({
    kind: CDB_RUNTIME_IDENTITY,
    protocolVersion: CDB_BRIDGE_PROTOCOL_VERSION,
    pageIrSchemaVersion: CDB_PAGE_IR_SCHEMA_VERSION,
    exactBuild,
  }, exactBuild);
}

function identityError(message) {
  const error = new Error(message);
  error.code = "runtime_identity_mismatch";
  return error;
}

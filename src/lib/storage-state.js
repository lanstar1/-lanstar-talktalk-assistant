import path from "node:path";

export function resolveStorageStatePath(rootDir, explicitPath) {
  const targetPath =
    explicitPath ?? process.env.TALKTALK_STORAGE_STATE_PATH ?? "storage/talktalk-account-1.state.json";

  return path.isAbsolute(targetPath) ? targetPath : path.join(rootDir, targetPath);
}

export function isValidStorageState(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      Array.isArray(payload.cookies) &&
      Array.isArray(payload.origins)
  );
}

export function isUploadAuthorized(headers, expectedToken) {
  if (!expectedToken) {
    return false;
  }

  const authorization = headers.authorization ?? "";
  if (authorization === `Bearer ${expectedToken}`) {
    return true;
  }

  return headers["x-upload-token"] === expectedToken;
}

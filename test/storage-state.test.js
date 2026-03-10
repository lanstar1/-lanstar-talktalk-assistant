import test from "node:test";
import assert from "node:assert/strict";

import {
  isUploadAuthorized,
  isValidStorageState,
  resolveStorageStatePath
} from "../src/lib/storage-state.js";

test("storageState 형식을 검증한다", () => {
  assert.equal(
    isValidStorageState({
      cookies: [],
      origins: []
    }),
    true
  );
  assert.equal(isValidStorageState({ cookies: [] }), false);
  assert.equal(isValidStorageState(null), false);
});

test("업로드 토큰 인증은 Bearer 또는 헤더 값을 허용한다", () => {
  assert.equal(
    isUploadAuthorized(
      { authorization: "Bearer secret-token" },
      "secret-token"
    ),
    true
  );
  assert.equal(
    isUploadAuthorized(
      { "x-upload-token": "secret-token" },
      "secret-token"
    ),
    true
  );
  assert.equal(isUploadAuthorized({}, "secret-token"), false);
});

test("상대 경로 storageState 파일 경로를 rootDir 기준으로 해석한다", () => {
  assert.equal(
    resolveStorageStatePath("/tmp/project", "storage/account-1.json"),
    "/tmp/project/storage/account-1.json"
  );
  assert.equal(
    resolveStorageStatePath("/tmp/project", "/var/data/account-1.json"),
    "/var/data/account-1.json"
  );
});

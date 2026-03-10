import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadProductCatalog } from "../src/lib/product-catalog.js";

test("제품 카탈로그는 exact, variant, family 순으로 모델을 매칭한다", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lanstar-product-catalog-"));
  const dataDir = path.join(rootDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "product_analysis.json"),
    JSON.stringify(
      {
        "LS-UH319": {
          카테고리: "USB to HDMI 컨버터",
          형태: "USB to HDMI 기본형",
          용도: "모니터 연결"
        },
        "LS-UH319-W": {
          카테고리: "컨버터",
          형태: "USB 3.0 to HDMI 컨버터",
          용도: "모니터 연결",
          규격: {
            INPUT: "USB 3.0",
            OUTPUT: "HDMI"
          }
        },
        "LS-UH319-W-Lanmart": {
          카테고리: "컨버터",
          형태: "USB 3.0 to HDMI 컨버터",
          용도: "모니터 연결"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const catalog = await loadProductCatalog(rootDir);

  const exact = catalog.findBestMatch({
    modelIdentifiers: ["LSUH319W"],
    rawHints: ["LS-UH319-W"]
  });
  assert.equal(exact.model, "LS-UH319-W");
  assert.equal(exact.matchType, "exact");

  const variant = catalog.findBestMatch({
    modelIdentifiers: ["UH319W"],
    rawHints: ["LS-UH319-W-Lanmart"]
  });
  assert.equal(variant.model, "LS-UH319-W");
  assert.equal(variant.matchType, "variant");

  const family = catalog.findBestMatch({
    modelIdentifiers: ["LSUH319BK"],
    rawHints: ["LS-UH319-BK"]
  });
  assert.equal(family.model, "LS-UH319");
  assert.equal(family.matchType, "family");
});

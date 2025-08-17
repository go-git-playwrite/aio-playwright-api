const text = await resp.text();
if (!text) continue;

tappedUrls.push(u);
tappedBodies.push({ url: u, ct, textLen: text.length });
fetchedMeta.push({ url: u, ct, textLen: text.length });

// ★ 追加：Unicodeデコードしてからスキャン
const raw = text || '';
const decoded = decodeUnicodeEscapes(raw);
const scan = raw + '\n' + decoded;

// 電話
(scan.match(PHONE_RE) || []).map(normalizeJpPhone).filter(Boolean).forEach(v => bundlePhones.push(v));

// 郵便番号
(scan.match(ZIP_RE) || []).filter(looksLikeZip7).forEach(v => bundleZips.push(v.replace(/^〒/, '')));

// 住所っぽい行
for (const line of scan.split(/\n+/)) {
  if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
    bundleAddrs.push(line.replace(/\s+/g,' ').trim());
  }
}

// 設立日（2nd pass）
if (!foundFoundingDate) {
  const hit = tryExtractFounding(scan);
  if (hit) foundFoundingDate = hit;
}

// sameAs
const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
for (const rawUrl of urlMatches) {
  try {
    const p = new URL(rawUrl);
    if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
  } catch(_) {}
}

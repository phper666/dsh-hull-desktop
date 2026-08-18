/**
 * 最小 semver 比较（S3 设计 D4：零依赖纯函数，prerelease 感知）。
 * 规则：x.y.z 数值比较优先；prerelease 段按 semver 规范——
 * 点分段比较，数字段数值比较、字母段 ASCII 字典序、数字段 < 字母段、段数少者优先；
 * prerelease < 正式版。
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 格式校验：x.y.z 或 x.y.z-pre（pre 段 [0-9A-Za-z.-]） */
export function isValidVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

/** pre-release 段比较（同段数对齐；段缺失方优先——段数少者较小） */
function comparePrerelease(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1; // a 段数少 → a 优先（较小）
    if (sb === undefined) return 1;
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const da = Number(sa) - Number(sb);
      if (da !== 0) return da < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1; // 数字段 < 字母段
    } else {
      // 字母段 ASCII 字典序（直接字符串比较，确定性与 locale 无关）
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
  }
  return 0;
}

/**
 * semver 比较：a < b → -1；相等 → 0；a > b → 1。
 * 非法输入 → throw（调用方先经 isValidVersion 校验，version-invalid 域）。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  if (!isValidVersion(a) || !isValidVersion(b)) {
    throw new Error(`非法 semver: "${a}" / "${b}"`);
  }
  const ma = SEMVER_RE.exec(a)!;
  const mb = SEMVER_RE.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1; // 正式版 > prerelease
  if (pb === undefined) return -1;
  return comparePrerelease(pa, pb);
}

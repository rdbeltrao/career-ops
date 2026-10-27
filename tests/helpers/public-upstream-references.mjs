import { createHash } from 'node:crypto';

// EVIDENCE: these exact lines were reviewed as public upstream attribution or
// maintainer policy (docs/reports/2026-10-27-test-warning-audit.md). Hashes keep
// the privacy-check fixtures from matching their own diagnostic patterns.
// Only this exact file, pattern, and every matching reviewed line qualify.
// Added candidate data or a changed line must be reviewed again; there is no
// whole-file exemption and no approval for similarly named nested files.
const reviewedLines = {
  ".github/scripts/ci-approve.mjs": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "9263c149292a0757629ab0a4ef2288f2bc86b6f9a8ffeb7af4e3dc4d11fec272",
      "c7fc8b1f981b84747771d5e786d8b5b35be2a5f8e3d3a3865d579f567b8c3860"
    ]
  },
  ".github/scripts/direction-gate.mjs": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "7f2686eaf21269e23917375d783027910144e6dfd0cfcfcd74516a5c77ce1ecd",
      "b9c693a97863ee3fbbdcf5d5d1b25063a5ca28637581f54a850dfd1064c213cd"
    ]
  },
  ".github/scripts/gfi-handoff.mjs": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "dc2ceb74acf23e57840b0ed7bd022dbce8c57ba707268e849e8f7fff8a15ef81"
    ]
  },
  ".github/scripts/triage.bundle.mjs": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "03840aaf655480a0834a1a65cfab455797e15d54021c829b5e9601e8a8c36d32",
      "7c99040983dadace72d5a0050218078ac0aec905e6ab81a8502c681b805e65d7",
      "988ae4829387cc66c46600bcee4303cd816d1d0ade1997afc79e6679a8239221",
      "a98805d079777cdb96d9d7ba5c8a7a44ce7f3a68fbb03a4855da929765daacf1",
      "c077e8f9f6058906a4ace98bb55f4323084ef12cea51f4ed1a1ad4fe928379b1",
      "caafc8e59140b2784c99403ed1d3c8c692f641480a2d99b537e5438eb0589b2d"
    ]
  },
  ".github/workflows/direction-gate.yml": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "22ec0378c1c4d785552412804763100ee37d3629da6f6337059f2e9d7099723b",
      "c5aba7126e8451654b6e704ff0c6b3e02a79d6c9dd627f274b3608c6c349acb0"
    ]
  },
  ".github/workflows/gfi-handoff.yml": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "b3fa6115b24226e029a214f731f0b8edbb7f4b8832982822c7f8c5b839d2ff32"
    ]
  },
  "README.vi.md": {
    "30362306091ef8d489fd8e92de49e5a40f3a2ffb6bda952f178fe394d8492fd9": [
      "17dcc013da9b2f8e5e3b491dedf7c662ff6ee129526b1069e5b25635e2e83157",
      "73cd3d8850cc1c81e7240b9944f3099815ece0f5b29a95b85df013a6e56b7fb4",
      "caa51b747f78b06c269f7283602c92cacc7a3b91f53bf745ccc29cff69d5a55f",
      "da5c6fe547022a0b9cd7ea807530b22e1170939a8837d50661eb318fad319704"
    ],
    "00a5be9a7dc9d666aa31c28bf891e72f00cf8bd83cf941aa4fc397e2de36559d": [
      "244ad35cdcff74ae1721939ff6719413e8d9d2f5cd60b3b118d7dcfc7b0339f3",
      "29a17c1ef88d1234a0989250fb10d923fa0b540d8840c1219ee0cf9e2d90b66e",
      "4a6819b0541f1ea6742b4ccc4dff58f6628799d5190e871282cec68baba01cb1",
      "570dc6579355131718fbf252715d391866b5aa941530931896407b05f88b53b7",
      "5a0ff937c61d75e30f0205f04612a29584dcff04996994c22ec81f67cf36f47a",
      "a0b07ccc5bc1008d0f6ce40f97e3e05e2ee5517a9aa7f53b756ac47e6263aded",
      "caa51b747f78b06c269f7283602c92cacc7a3b91f53bf745ccc29cff69d5a55f",
      "da5c6fe547022a0b9cd7ea807530b22e1170939a8837d50661eb318fad319704",
      "e440813dbb51c3e51e38a9faa3c784a5be2663278d1de6aa1c2e87146b85de43"
    ],
    "c044e964a1dad321b6a0b8f0d256e29a436b106c7ee002c6f45936fd2cbcad9d": [
      "4a6819b0541f1ea6742b4ccc4dff58f6628799d5190e871282cec68baba01cb1"
    ]
  }
};

const digest = value => createHash('sha256').update(value).digest('hex');

export function approvedUpstreamReference(file, pattern, source) {
  const approved = reviewedLines[file]?.[digest(pattern)];
  // EVIDENCE: git grep -G uses basic regular expressions, including wildcard
  // dots in the reviewed domain patterns. These approvals contain only ASCII
  // letters, @ and dot, whose BRE meaning is identical to this Unicode/dotAll
  // expression. Fail closed for any other syntax if approvals are extended.
  if (!approved || !/^[A-Za-z@.]+$/.test(pattern)) return false;
  const matcher = new RegExp(pattern, 'su');
  const matches = source.split(/\r?\n/).filter(line => matcher.test(line));
  return matches.length > 0 && matches.every(line => approved.includes(digest(line)));
}

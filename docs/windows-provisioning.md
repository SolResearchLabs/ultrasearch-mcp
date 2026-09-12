# Windows provisioning

The pinned SearXNG web application cannot import on native Windows: its
first-party chain requires the POSIX-only `pwd` module. Stage C of the
`FULL-PACKAGE-005` lab work found exactly two first-party textual hits, both
in `searx/valkeydb.py` - the unconditional `import pwd` (executed whenever the
web app module is imported) and the Valkey connection-error logger's
`pwd.getpwuid(os.getuid())`. The Windows accommodation is a two-edit patch to
that one file, applied at provisioning time.

## The patch is external and not vendored

The patch artifact is lab-only. It is never committed to, copied into,
vendored in, or shipped with this repository, and it is never used as a test
fixture - including at test runtime. This repository carries only the recorded
digests, as constants in `src/control-plane/provisioning.ts`. The tests for
that module use synthetic temp-dir fixtures only: a local `git init`
repository with no remote, a synthetic patch, and a synthetic archive.

## Provisioning-time verification

`applySearxngWindowsPatch()` in `src/control-plane/provisioning.ts` is the
production provisioning entry: an explicit opt-in call. Importing the module
has no side effects, and nothing in the build or test run executes the apply
path automatically. The function performs no network access, reads no
credentials, and never copies or vendors upstream sources.

The production entry verifies against the recorded constants and against
nothing else. It takes no identity override parameter at all, so a caller
cannot substitute pin, tree, archive or patch digests, and a checkout that is
not the pinned snapshot is refused with `pin_mismatch` or `tree_mismatch`. It
verifies, in order, before any apply:

1. a checkout exists at the given path;
2. `git rev-parse HEAD` succeeds and equals the recorded pin commit;
3. `git rev-parse HEAD^{tree}` equals the recorded tree id;
4. the pinned source archive's SHA-256 and byte count equal the recorded
   values;
5. the patch file's SHA-256 and byte count equal the recorded values;
6. the patch file's SHA-256 and byte count are re-derived again immediately
   before `git apply --check`;
7. `git apply --check` exits zero;
8. the patch file's SHA-256 and byte count are re-derived once more
   immediately before `git apply`.

Only then does it run `git apply`. Git children run with an explicit
allowlisted environment - `PATH`, `SystemRoot`, `TEMP`, `TMP` and `PATHEXT` on
Windows, plus `GIT_TERMINAL_PROMPT=0` - never an inherited process
environment: ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_*`,
`GIT_CONFIG_VALUE_*`, `GIT_OBJECT_DIRECTORY` and
`GIT_ALTERNATE_OBJECT_DIRECTORIES` cannot reach a provisioning git child and
cannot redirect what `git -C` resolves.

## Test-only fixture variant

`applyPatchToCheckoutForFixture()` is a separate low-level function in the
same module. It verifies against an identity supplied by the caller, so the
test suite can point it at synthetic temp-dir fixtures without touching the
real artifact. It is fixture/test-only and is not part of any provisioning
path: nothing in this repository calls it outside the test suite, and
production callers must use `applySearxngWindowsPatch()`, which verifies the
recorded identity only.

## Exact refusal conditions

Every mismatch fails closed with a specific `ProvisioningRefusalError` code;
none is downgraded to a warning, and none has a fallback:

| Code | Condition |
| --- | --- |
| `missing_checkout` | the checkout path does not exist |
| `missing_archive` | the source archive cannot be read |
| `missing_patch` | the patch file cannot be read |
| `git_unavailable` | the git executable cannot be spawned or exits without a status |
| `not_a_repository` | `git rev-parse HEAD` or `HEAD^{tree}` fails in the checkout |
| `pin_mismatch` | resolved HEAD is not the recorded pin commit |
| `tree_mismatch` | resolved tree id is not the recorded tree id |
| `archive_digest_mismatch` | archive SHA-256 or byte count differs |
| `patch_digest_mismatch` | patch SHA-256 or byte count differs, at the initial read or at either the pre-check or pre-apply re-verification |
| `apply_check_failed` | `git apply --check` exits non-zero |
| `apply_failed` | `git apply` exits non-zero after a passing check |

There is no fallback path, no `--3way`, no `-reject`, no fuzzy apply, and no
silent skip. A refusal leaves the checkout unmodified.

## Recorded verified values

| Identity | Value |
| --- | --- |
| Pin commit | `61d660276f1288e7d512e8d8da46cb8442728454` |
| Tree id | `e19e011ab39e72759973256c3b6184390e6d9012` |
| Archive SHA-256 | `0561637c70ecb39c70f0c19daaad3743b5bc9ad858f5e609ef326abd4fa7205d` |
| Archive bytes | `21944320` |
| Patch SHA-256 | `75e90a05069199788ccc97c9160fe955a00d207415074e9c6a34245764385dbc` |
| Patch bytes | `963` |

The artifact digest is the identity of the accommodation: a patch with a
different digest is a different accommodation, not a repair. The digest is
re-verified at provision time - including immediately before `git apply`, so a
patch swapped after `git apply --check` is refused rather than applied - and
any mismatch refuses rather than adjusts.

## Disclosed residual limits

- Patch applicability is verified against the pinned checkout. Runtime and
  end-to-end behavior are **not** yet claimed by this repository.
- The git executable is a caller-supplied parameter. A caller that passes a
  fake `git` which prints the recorded values and exits zero can obtain a
  success result without applying anything. Provisioning callers must pass a
  trusted git executable.
- A micro-window remains between the final patch-digest re-derivation and the
  `git apply` spawn; path-based `git apply` cannot close it entirely.
- `applyPatchToCheckoutForFixture()` is exported for the test suite; it is not
  part of any provisioning path and must not be called by production code.
- The sanitized git child environment drops `HOME` and `USERPROFILE`, so
  user-level git configuration no longer reaches provisioning children (system
  and repository configuration still do). The failure mode of that difference
  is refusal, not a weakened check.

## Residual scope limit

The inventory behind this accommodation covers first-party textual hits only.
It does not scan the third-party dependency closure (site-packages, the
standard library, or host environment state), and it does not exclude
indirect or dynamic imports, aliases, `importlib` with constructed names, or
dynamically constructed attribute access. The governing rule is carried
verbatim: "post-pwd POSIX assumptions: unknown, not absent." It excludes the
first-party `searx` textual hits named above and nothing more.

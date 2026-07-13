---
---

Add `--max-warnings 941` to the root `lint` script so new ESLint warnings fail CI instead of disappearing into the existing baseline. (Originally set to 902, the count on `main` when this PR was opened; rebasing onto `main`'s subsequent commits raised the actual warning count to 941, so the ratchet value was updated to match.)

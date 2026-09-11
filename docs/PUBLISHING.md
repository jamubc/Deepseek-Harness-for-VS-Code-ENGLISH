# Publishing this fork

You do **not** need any of this to use the extension — install the `.vsix` and you are
done. This page is only for putting the English edition on the VS Code Marketplace.

## 1. Decide the identity

| Field | Current value | Meaning |
| --- | --- | --- |
| `publisher` | `jamubc` | Your Marketplace publisher **id**. Must match the account you publish under, or `vsce publish` refuses. |
| `name` | `deepseek-harness-vscode` | Part of the extension's permanent id. |
| `displayName` | `DeepSeek Harness for VS Code (English)` | What users see in the Marketplace. |

The public id is `publisher.name` — currently `jamubc.deepseek-harness-vscode`.

> **`publisher` must not stay `vithrive`.** That is upstream's publisher id, and
> publishing under it would either fail or target someone else's account.
> `npm run l10n:check` fails if you set it back.

If you would rather not collide with upstream's extension id at all, rename both:

```jsonc
"name": "deepseek-harness-vscode-english",
"displayName": "DeepSeek Harness for VS Code (English)",
```

Then run `npm run l10n:check` — nothing else references the name.

## 2. Create the publisher and a token

1. Sign in to <https://marketplace.visualstudio.com/manage> with the Microsoft account
   you want to own the extension.
2. **Create publisher**. Use `jamubc` (or whatever you set in `package.json`). The id is
   permanent.
3. Create a **Personal Access Token** at <https://dev.azure.com/> →
   *User settings* → *Personal access tokens* → **New Token**:
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined** → **Marketplace** → **Manage**
   - Copy the token; it is shown once.

## 3. Let GitHub do the publishing

Add the token to the repository so the release workflow can use it:

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
| --- | --- |
| `VSCE_PAT` | the token from step 2 |

Then publish by pushing a tag:

```bash
git tag v0.8.44          # keep in step with upstream's version
git push origin v0.8.44
```

The [release workflow](../.github/workflows/release.yml) then:

1. runs `npm run l10n:check` and the test suite — it will not publish a half-translated build;
2. fails fast if `publisher` is still `vithrive`;
3. builds the `.vsix` with `vsce`;
4. attaches it to a GitHub release, so `.../releases/latest` always offers a download;
5. publishes to the Marketplace **only if `VSCE_PAT` is set**.

Without the secret you still get the GitHub release and its `.vsix`, which is enough to
share the extension. It just will not appear in Marketplace search.

## 4. Publishing by hand (optional)

```bash
npx @vscode/vsce login jamubc     # paste the PAT when prompted
npm test && npm run l10n:check
npx @vscode/vsce publish          # bumps nothing; publishes package.json's version
```

`vsce publish minor` / `patch` bump the version for you — but see below.

## Versioning

`package.json` `version` **tracks upstream's version** on purpose. This fork adds no
features, so keeping the numbers aligned makes it obvious which upstream release an
English build corresponds to, and gives the daily sync workflow a clean signal when
upstream ships.

Upstream's version reaches this repository through the sync workflow; do not invent
your own numbers, or the correspondence is lost.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ERROR Missing publisher name` | `publisher` in `package.json` does not match your Marketplace publisher id. |
| `ERROR Access Denied` / 401 | The PAT is expired, is not scoped to **Marketplace → Manage**, or was not created for *All accessible organizations*. |
| `ERROR Extension 'x.y' already exists` | The id is owned by another account. Change `name`. |
| `ERROR The extension icon is missing` | `media/icon.png` must exist and be at least 128×128. |
| `ERROR Make sure to edit the README.md` | The packaged `README.md` is empty or missing; it is the listing text. |
| Extension publishes but shows Chinese | `npm run l10n:check` was skipped. It must exit 0 first. |

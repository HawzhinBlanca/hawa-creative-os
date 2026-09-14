# T02 Proof: Fonts Installation and Container Image Verification

- **Date / Timestamp**: 2026-09-14T09:25:37Z (12:25:37 local)
- **Branch**: `studio-v2`
- **Component**: `@hawa/creative` & Core Container Image

---

## 1. Font Asset SHA-256 Hashes & Licenses

The following official Google Fonts TTF files and their Open Font License (OFL 1.1) texts are committed into `packages/creative/assets/fonts/`:

| Font File | Style | Bytes | SHA-256 | License File |
|---|---|---|---|---|
| `EBGaramond-Regular.ttf` | Regular | 627,304 | `2028dc06d3c130b4761693481436a32a8e35ed500bf58c25c53de004106125b8` | `OFL-EBGaramond.txt` |
| `EBGaramond-SemiBold.ttf` | SemiBold | 687,548 | `ebf827a102983972abb2a1a3964afd5a7b79ca04f2ddd9e53917ce623cefdf2c` | `OFL-EBGaramond.txt` |
| `EBGaramond-Bold.ttf` | Bold | 687,396 | `0cfed122e51e3fd44ccedaef7637efed6d5bdc4ad89a6117d70241510309a186` | `OFL-EBGaramond.txt` |
| `EBGaramond-Italic.ttf` | Italic | 602,136 | `d4ad1d0a9390d26d6d3f176117a1d121441edb8c8632bfca52cfad084b9059cb` | `OFL-EBGaramond.txt` |
| `NotoSansArabic-Regular.ttf` | Regular | 142,140 | `bd86ca02f087d7f3c3788ba458fb6b73744c7639ed276b8d870dba6def6c40d0` | `OFL-NotoSansArabic.txt` |
| `NotoSansArabic-Bold.ttf` | Bold | 141,852 | `f4cb79f842a07d1bcf597879574358fb7010f73761396d1d0f2445dfedb4d2ca` | `OFL-NotoSansArabic.txt` |
| `OFL-EBGaramond.txt` | License | 4,454 | `058611bd968817d532cedeab6acaa055e882d365a88523df00e7917ad7a0f704` | SIL Open Font License 1.1 |
| `OFL-NotoSansArabic.txt` | License | 4,382 | `a7a5a25eb188bf1cd96982030d53e23c33485c69b1044a562254226857ee13af` | SIL Open Font License 1.1 |

---

## 2. Configuration & Manifests

1. **`packages/creative/src/studio/render-fonts.json`**:
   Configured with font family mappings, weights, OFL licenses, and fidelity indicators:
   - `EB Garamond`: `stand-in` for `Minion Variable Concept`
   - `Minion Variable Concept`: `exact` (requires private licensed binary)
   - `Noto Sans Arabic`: `exact` (Sorani Kurdish script font)

2. **`packages/creative/assets/fonts/fonts.conf`**:
   Extended with `<dir prefix="relative">./private</dir>` to allow automatic inclusion of licensed fonts if provided by the user.

3. **`.gitignore`**:
   Updated with `packages/creative/assets/fonts/private/` to guarantee no proprietary licensed font binaries can ever be committed to the repository.

4. **`infra/docker/Dockerfile.core`**:
   - Configured with `ENV FONTCONFIG_FILE=/app/packages/creative/assets/fonts/fonts.conf`
   - Registered TTF files into `/usr/local/share/fonts/hawa` with fontconfig cache refresh `fc-cache -f`.

---

## 3. Acceptance Verification Command & Output

Command executed:
```bash
docker run --rm hawa-production-core:test fc-list | grep -E "EB Garamond|Noto Sans Arabic"
```

Output:
```
/app/packages/creative/assets/fonts/NotoSansArabic-Regular.ttf: Noto Sans Arabic:style=Regular
/app/packages/creative/assets/fonts/EBGaramond-SemiBold.ttf: EB Garamond,EB Garamond SemiBold:style=SemiBold,Regular
/app/packages/creative/assets/fonts/EBGaramond-Regular.ttf: EB Garamond:style=Regular
/app/packages/creative/assets/fonts/EBGaramond-Italic.ttf: EB Garamond:style=Italic
/app/packages/creative/assets/fonts/NotoSansArabic-Bold.ttf: Noto Sans Arabic:style=Bold
/app/packages/creative/assets/fonts/EBGaramond-Bold.ttf: EB Garamond:style=Bold
```

All required font families, weights, and styles are recognized and resolved by Fontconfig in the built container image.

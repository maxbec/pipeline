# Changelog

## [3.5.0](https://github.com/maxbec/pipeline/compare/v3.4.1...v3.5.0) (2026-08-14)


### ✨ Features

* one-button release — auto promotion PR, stable release PR auto-merge, back-merge wiring ([#10](https://github.com/maxbec/pipeline/issues/10)) ([3f85bf1](https://github.com/maxbec/pipeline/commit/3f85bf16bada04b37e62026b08c163f59b4a6cf1))
* **scripts:** new-repo provisioning script (paved road for new repos) ([2ec280c](https://github.com/maxbec/pipeline/commit/2ec280ccda34790849af0071763bca1e9683f844))


### 🐛 Bug Fixes

* **flama:** rehome delivery contract to maxbec/pipeline ([#4](https://github.com/maxbec/pipeline/issues/4)) ([903497f](https://github.com/maxbec/pipeline/commit/903497f425d14e0523a6759900247ef9e9d78836))
* **promote:** direct dev-head promotion PR when the merge is clean (auto mode) ([#12](https://github.com/maxbec/pipeline/issues/12)) ([99237a6](https://github.com/maxbec/pipeline/commit/99237a670e8ba57769f43639b6aa754443850a16))
* **release:** decouple the dev beta release track from stable-track files ([#14](https://github.com/maxbec/pipeline/issues/14)) ([2b836e6](https://github.com/maxbec/pipeline/commit/2b836e6f6cb17b86421dcb8a936121541ae92fe5))

## [3.4.0](https://github.com/maxbec/pipeline) (2026-08-14)

Stable promotion of the 3.3.0-beta line. Highlights:

* **pipeline:** pass Cloudflare Access service-token headers to Infisical (#290)
* **ci:** adopt Flama delivery platform 0.5.3 gates (#282, #284, #287, #289)
* rehomed from navigaite/.github to maxbec/pipeline

## [3.3.0-beta.18](https://github.com/navigaite/.github/compare/v3.3.0-beta.17...v3.3.0-beta.18) (2026-08-13)


### ✨ Features

* **pipeline:** pass Cloudflare Access service-token headers to Infisical ([#290](https://github.com/navigaite/.github/issues/290)) ([91d5a6c](https://github.com/navigaite/.github/commit/91d5a6c4f167218193edf7f59e2933959e41ef67))

## [3.3.0-beta.17](https://github.com/navigaite/.github/compare/v3.3.0-beta.16...v3.3.0-beta.17) (2026-07-26)


### 🐛 Bug Fixes

* **pipeline:** point TMPDIR at RUNNER_TEMP on self-hosted jobs (NAV-54) ([#274](https://github.com/navigaite/.github/issues/274)) ([42192e7](https://github.com/navigaite/.github/commit/42192e73ef28dfe92a103f9e45dcb20a0a2fe323))

## [3.3.0-beta.16](https://github.com/navigaite/.github/compare/v3.3.0-beta.15...v3.3.0-beta.16) (2026-07-26)


### 🐛 Bug Fixes

* **ci:** reconcile rolling tags decoupled from release-please outcome (NAV-53) ([#270](https://github.com/navigaite/.github/issues/270)) ([d42ff42](https://github.com/navigaite/.github/commit/d42ff42b188076224f8efe867ce1b40be280b8fb))

## [3.3.0-beta.15](https://github.com/navigaite/.github/compare/v3.3.0-beta.14...v3.3.0-beta.15) (2026-07-26)


### 🐛 Bug Fixes

* **ci:** allow bot-authored promote/* heads in Branch Guard (NAV-21) ([#265](https://github.com/navigaite/.github/issues/265)) ([d3fc194](https://github.com/navigaite/.github/commit/d3fc194e1cdb589a1d8d7c50c59996678497d868))

## [3.3.0-beta.14](https://github.com/navigaite/.github/compare/v3.3.0-beta.13...v3.3.0-beta.14) (2026-07-26)


### 🐛 Bug Fixes

* **sync:** retire impossible main→dev back-merge; reconcile via auto-merged PR (NAV-50) ([#261](https://github.com/navigaite/.github/issues/261)) ([bc566cc](https://github.com/navigaite/.github/commit/bc566ccbdcacff2bf3732474615a4ac362fe9aee))

## [3.3.0-beta.13](https://github.com/navigaite/.github/compare/v3.3.0-beta.12...v3.3.0-beta.13) (2026-07-26)


### 🐛 Bug Fixes

* **promote:** durable conflict-free dev→main promotion (NAV-46) ([#259](https://github.com/navigaite/.github/issues/259)) ([7c9db56](https://github.com/navigaite/.github/commit/7c9db56a62a4e4abbe5ba7afd924a709fc1442a7))
* **security-scan:** run TruffleHog Docker-less for self-hosted runners ([#258](https://github.com/navigaite/.github/issues/258)) ([515e08a](https://github.com/navigaite/.github/commit/515e08a16af5e40c7f89d22a7ff37fc508e147e5))

## [3.3.0-beta.12](https://github.com/navigaite/.github/compare/v3.3.0-beta.11...v3.3.0-beta.12) (2026-07-26)


### 🐛 Bug Fixes

* **pipeline:** plumb NPM_TOKEN into semantic-release publish (NAV-41) ([#256](https://github.com/navigaite/.github/issues/256)) ([736289c](https://github.com/navigaite/.github/commit/736289ce4e2bd59fc9af91821857461194364bbc))

## [3.3.0-beta.11](https://github.com/navigaite/.github/compare/v3.2.1-beta.11...v3.3.0-beta.11) (2026-07-26)


### ✨ Features

* **pipeline:** add fast|major repo profile knob (NAV-21) ([#254](https://github.com/navigaite/.github/issues/254)) ([88322aa](https://github.com/navigaite/.github/commit/88322aaa8ec6721b2592711e4125e124f07e7fbe))

## [3.2.2](https://github.com/navigaite/.github/compare/v3.2.1...v3.2.2) (2026-07-24)


### 🐛 Bug Fixes

* **ci:** a required gate can never pass on skipped validation (NAV-20) ([#237](https://github.com/navigaite/.github/issues/237)) ([f93bf86](https://github.com/navigaite/.github/commit/f93bf86743f38e3e6b64658a0f1c15e5de2da152))
* **ci:** downgrade dependency-review unsupported-repo case to warning ([#225](https://github.com/navigaite/.github/issues/225)) ([a432042](https://github.com/navigaite/.github/commit/a43204200c2c1540854778d7a8ea9bb88be6ca5b))
* land NAV-21 audit fixes to the universal pipeline ([#236](https://github.com/navigaite/.github/issues/236)) ([90e59cb](https://github.com/navigaite/.github/commit/90e59cb771988ef10d7399cdcf345924577a228a))
* **runner:** drop cap_drop ALL from hardened self-hosted runner compose ([#244](https://github.com/navigaite/.github/issues/244)) ([9ff4047](https://github.com/navigaite/.github/commit/9ff404796f7d99b5fdb8c6932f3a9bc3120b84b0))


### ⚡ Performance Improvements

* **ci:** skip deploy jobs on empty matrix — stop phantom runners (PRI-721 Scope A) ([#234](https://github.com/navigaite/.github/issues/234)) ([23b5739](https://github.com/navigaite/.github/commit/23b5739cd647d8645451016a3a3b2b17ef2b48a7))


### 📚 Documentation

* **runner:** hardened self-hosted runner + library/WP pipeline templates (NAV-27) ([#242](https://github.com/navigaite/.github/issues/242)) ([a45241c](https://github.com/navigaite/.github/commit/a45241cad983ae16e495086aa683258f35edaa37))

## [3.2.1-beta.11](https://github.com/navigaite/.github/compare/v3.2.1-beta.10...v3.2.1-beta.11) (2026-07-25)


### 🐛 Bug Fixes

* **ci:** drop checks:write over-request that startup-fails every consumer on [@v3](https://github.com/v3) ([#248](https://github.com/navigaite/.github/issues/248)) ([8819bd1](https://github.com/navigaite/.github/commit/8819bd18bad6209fda7ad671abd33b091db31486))

## [3.2.1-beta.10](https://github.com/navigaite/.github/compare/v3.2.1-beta.9...v3.2.1-beta.10) (2026-07-24)


### 🐛 Bug Fixes

* **runner:** drop cap_drop ALL from hardened self-hosted runner compose ([#244](https://github.com/navigaite/.github/issues/244)) ([9ff4047](https://github.com/navigaite/.github/commit/9ff404796f7d99b5fdb8c6932f3a9bc3120b84b0))

## [3.2.1-beta.9](https://github.com/navigaite/.github/compare/v3.2.1-beta.8...v3.2.1-beta.9) (2026-07-23)


### 📚 Documentation

* **runner:** hardened self-hosted runner + library/WP pipeline templates (NAV-27) ([#242](https://github.com/navigaite/.github/issues/242)) ([a45241c](https://github.com/navigaite/.github/commit/a45241cad983ae16e495086aa683258f35edaa37))

## [3.2.1-beta.8](https://github.com/navigaite/.github/compare/v3.2.1-beta.7...v3.2.1-beta.8) (2026-07-23)


### 🐛 Bug Fixes

* land NAV-21 audit fixes to the universal pipeline ([#236](https://github.com/navigaite/.github/issues/236)) ([90e59cb](https://github.com/navigaite/.github/commit/90e59cb771988ef10d7399cdcf345924577a228a))

## [3.2.1-beta.7](https://github.com/navigaite/.github/compare/v3.2.1-beta.6...v3.2.1-beta.7) (2026-07-23)


### 🐛 Bug Fixes

* **ci:** a required gate can never pass on skipped validation (NAV-20) ([#237](https://github.com/navigaite/.github/issues/237)) ([f93bf86](https://github.com/navigaite/.github/commit/f93bf86743f38e3e6b64658a0f1c15e5de2da152))

## [3.2.1-beta.6](https://github.com/navigaite/.github/compare/v3.2.1-beta.5...v3.2.1-beta.6) (2026-07-21)


### ⚡ Performance Improvements

* **ci:** skip deploy jobs on empty matrix — stop phantom runners (PRI-721 Scope A) ([#234](https://github.com/navigaite/.github/issues/234)) ([23b5739](https://github.com/navigaite/.github/commit/23b5739cd647d8645451016a3a3b2b17ef2b48a7))

## [3.2.1](https://github.com/navigaite/.github/compare/v3.2.0...v3.2.1) (2026-07-19)


### 🐛 Bug Fixes

* **pipeline:** honor explicit enable: false in pipeline.yaml ([#216](https://github.com/navigaite/.github/issues/216)) ([a5921c6](https://github.com/navigaite/.github/commit/a5921c6f8dda425fb695028312078d34f3c6e29b))
* **pipeline:** honor explicit enable: false in pipeline.yaml (PRI-674) ([a5921c6](https://github.com/navigaite/.github/commit/a5921c6f8dda425fb695028312078d34f3c6e29b))
* **release:** read prerelease config from branch, not runner disk ([#212](https://github.com/navigaite/.github/issues/212)) ([1306d8c](https://github.com/navigaite/.github/commit/1306d8c12a2b32a26ad55e42f727a8dede29d111))
* **release:** sync main manifest baseline to 3.2.0 (PRI-675) ([#220](https://github.com/navigaite/.github/issues/220)) ([c4299d7](https://github.com/navigaite/.github/commit/c4299d7fa7d984050f0299454b727bdd1d91feaf))


### ⚡ Performance Improvements

* **ci:** fold Pipeline Summary into caller Check Gate (PRI-630) ([#214](https://github.com/navigaite/.github/issues/214)) ([6310de1](https://github.com/navigaite/.github/commit/6310de1a49123f07a9ada86f003ebce66c517d62))

## [3.2.1-beta.3](https://github.com/navigaite/.github/compare/v3.2.1-beta.2...v3.2.1-beta.3) (2026-07-19)


### 🐛 Bug Fixes

* **release:** sync main manifest baseline to 3.2.0 (PRI-675) ([#220](https://github.com/navigaite/.github/issues/220)) ([c4299d7](https://github.com/navigaite/.github/commit/c4299d7fa7d984050f0299454b727bdd1d91feaf))

## [3.2.1-beta.2](https://github.com/navigaite/.github/compare/v3.2.1-beta.1...v3.2.1-beta.2) (2026-07-18)


### 🐛 Bug Fixes

* **pipeline:** honor explicit enable: false in pipeline.yaml ([#216](https://github.com/navigaite/.github/issues/216)) ([a5921c6](https://github.com/navigaite/.github/commit/a5921c6f8dda425fb695028312078d34f3c6e29b))
* **pipeline:** honor explicit enable: false in pipeline.yaml (PRI-674) ([a5921c6](https://github.com/navigaite/.github/commit/a5921c6f8dda425fb695028312078d34f3c6e29b))

## [3.2.1-beta.1](https://github.com/navigaite/.github/compare/v3.2.1-beta...v3.2.1-beta.1) (2026-07-18)


### ⚡ Performance Improvements

* **ci:** fold Pipeline Summary into caller Check Gate (PRI-630) ([#214](https://github.com/navigaite/.github/issues/214)) ([6310de1](https://github.com/navigaite/.github/commit/6310de1a49123f07a9ada86f003ebce66c517d62))

## [3.2.1-beta](https://github.com/navigaite/.github/compare/v3.2.0...v3.2.1-beta) (2026-07-18)


### 🐛 Bug Fixes

* **release:** read prerelease config from branch, not runner disk ([#212](https://github.com/navigaite/.github/issues/212)) ([1306d8c](https://github.com/navigaite/.github/commit/1306d8c12a2b32a26ad55e42f727a8dede29d111))

## [3.2.0](https://github.com/navigaite/.github/compare/v3.1.1...v3.2.0) (2026-07-18)


### ✨ Features

* **release:** migrate to two-branch model (PRI-637) ([#206](https://github.com/navigaite/.github/issues/206)) ([e7b35d8](https://github.com/navigaite/.github/commit/e7b35d874d7177bd72ad205877d11595de511263))


### 🐛 Bug Fixes

* **release:** correct dev manifest baseline after bad v4.0.0-beta.0 release (PRI-637) ([#210](https://github.com/navigaite/.github/issues/210)) ([9888bb8](https://github.com/navigaite/.github/commit/9888bb837b15c095714b166fd48685cad0523f9b))
* **release:** seed dev manifest with prerelease cursor (PRI-637) ([#208](https://github.com/navigaite/.github/issues/208)) ([ad0f08b](https://github.com/navigaite/.github/commit/ad0f08b4d339f9c565d696c9693bb214d06f47f2))

## [3.2.0](https://github.com/navigaite/.github/compare/v3.1.1...v3.2.0) (2026-07-18)


### ✨ Features

* **release:** migrate to two-branch model (PRI-637) ([#206](https://github.com/navigaite/.github/issues/206)) ([e7b35d8](https://github.com/navigaite/.github/commit/e7b35d874d7177bd72ad205877d11595de511263))

## [3.1.1](https://github.com/navigaite/.github/compare/v3.1.0...v3.1.1) (2026-07-18)


### 🐛 Bug Fixes

* **hmac-cron-post:** harden against 3xx false-green + caller audit (PRI-633) ([#204](https://github.com/navigaite/.github/issues/204)) ([b517fc4](https://github.com/navigaite/.github/commit/b517fc41b24731b9a3b76bc7159137fc9a7e55ac))

## [3.1.0](https://github.com/navigaite/.github/compare/v3.0.2...v3.1.0) (2026-07-18)


### ✨ Features

* **pipeline:** add runner.labels opt-in for self-hosted runners ([#202](https://github.com/navigaite/.github/issues/202)) ([a6728e9](https://github.com/navigaite/.github/commit/a6728e950f2f5a48de05196d2fd2c5fa44821dc1))

## [3.0.2](https://github.com/navigaite/.github/compare/v3.0.1...v3.0.2) (2026-07-18)


### 🐛 Bug Fixes

* **release-management:** set versioning-strategy on prerelease branches ([#200](https://github.com/navigaite/.github/issues/200)) ([6cc8580](https://github.com/navigaite/.github/commit/6cc85801188ecaf7588463f63d59f2b6f64b3319))

## [3.0.1](https://github.com/navigaite/.github/compare/v3.0.0...v3.0.1) (2026-06-18)


### 🐛 Bug Fixes

* **pipeline:** reject Cloudflare Access challenge in Infisical probe (EDI-404) ([#183](https://github.com/navigaite/.github/issues/183)) ([e4efc08](https://github.com/navigaite/.github/commit/e4efc089e872d83944427feedd70f209e025ec9b))

## [3.0.0](https://github.com/navigaite/.github/compare/v2.14.0...v3.0.0) (2026-06-17)


### ⚠ BREAKING CHANGES

* **pipeline:** consolidate CI jobs into static-checks + verify (EDI-389)

### ✨ Features

* **pipeline:** consolidate CI jobs into static-checks + verify (EDI-389) ([63532b5](https://github.com/navigaite/.github/commit/63532b5ff2a8015987e85b4e42f84b74c99a25e7))

## [2.14.0](https://github.com/navigaite/.github/compare/v2.13.1...v2.14.0) (2026-06-17)


### ✨ Features

* **release:** auto-reconcile dev prerelease manifest after promotion ([348f46b](https://github.com/navigaite/.github/commit/348f46b5e091cc41a4f10b20cb87a3b08ccbc2ac))

## [2.13.1](https://github.com/navigaite/.github/compare/v2.13.0...v2.13.1) (2026-06-17)


### 🐛 Bug Fixes

* **pipeline:** probe Infisical reachability before Build injection (EDI-381) ([9da43d8](https://github.com/navigaite/.github/commit/9da43d89b09223bcd4c99e58d804f14f43a1145b))

## [2.13.0](https://github.com/navigaite/.github/compare/v2.12.2...v2.13.0) (2026-05-31)


### ✨ Features

* **release:** add manifest_file_stable for per-stream manifests ([#167](https://github.com/navigaite/.github/issues/167)) ([d9a6154](https://github.com/navigaite/.github/commit/d9a615459289a402769389d3263995152fa53de0))

## [2.12.2](https://github.com/navigaite/.github/compare/v2.12.1...v2.12.2) (2026-05-31)


### 🐛 Bug Fixes

* **ci:** keep nightly green when Code Scanning is unavailable ([#165](https://github.com/navigaite/.github/issues/165)) ([5fdf159](https://github.com/navigaite/.github/commit/5fdf159eeb0289a7622f52653ee64c5056da3590))

## [2.12.1](https://github.com/navigaite/.github/compare/v2.12.0...v2.12.1) (2026-05-26)


### 🐛 Bug Fixes

* **docs:** nudge v2 sha (codeload wedged on 33701f1) ([#163](https://github.com/navigaite/.github/issues/163)) ([fbb8d76](https://github.com/navigaite/.github/commit/fbb8d76ff47f98dd556aafb8c18ba555d64e693c))

## [2.12.0](https://github.com/navigaite/.github/compare/v2.11.0...v2.12.0) (2026-05-26)


### ✨ Features

* **workflows:** add promote-to-main + hmac-cron-post reusables ([#161](https://github.com/navigaite/.github/issues/161)) ([c7e1912](https://github.com/navigaite/.github/commit/c7e19120cba7f96b670c0f770775560e103defb2))

## [2.11.0](https://github.com/navigaite/.github/compare/v2.10.0...v2.11.0) (2026-05-25)


### ✨ Features

* add OIDC support for Infisical secrets loading ([#159](https://github.com/navigaite/.github/issues/159)) ([c8a982d](https://github.com/navigaite/.github/commit/c8a982d2455e1deffdfc93a13c7d942f48b7f8ee))

## [2.10.0](https://github.com/navigaite/.github/compare/v2.9.3...v2.10.0) (2026-05-19)


### ✨ Features

* extend docs-only detection to push events + tighten Claude Code Fix triggers ([#152](https://github.com/navigaite/.github/issues/152)) ([b042759](https://github.com/navigaite/.github/commit/b042759d779580c181f89611b2f4bb42ac640399))

## [2.9.3](https://github.com/navigaite/.github/compare/v2.9.2...v2.9.3) (2026-05-06)


### 🐛 Bug Fixes

* **trunk-upgrade:** sign bot commits via Contents API ([#140](https://github.com/navigaite/.github/issues/140)) ([d513140](https://github.com/navigaite/.github/commit/d51314070dbedaa24019a56512f3ed5f55fb34bf))

## [2.9.2](https://github.com/navigaite/.github/compare/v2.9.1...v2.9.2) (2026-05-02)


### ⚡ Performance Improvements

* **ci:** parallelize build with lint+test, preserve dev concurrency ([#134](https://github.com/navigaite/.github/issues/134)) ([82317b5](https://github.com/navigaite/.github/commit/82317b5dad8d9818058635d0df96dc03ebe6a574))

## [2.9.1](https://github.com/navigaite/.github/compare/v2.9.0...v2.9.1) (2026-04-21)


### 🐛 Bug Fixes

* **ci:** correct turbo cache path and key for turbo 2.x ([#126](https://github.com/navigaite/.github/issues/126)) ([78e9ba7](https://github.com/navigaite/.github/commit/78e9ba7ce05cff93d1cf49ea2efb99be9ea0b8e3))

## [2.9.0](https://github.com/navigaite/.github/compare/v2.8.0...v2.9.0) (2026-04-21)


### ✨ Features

* **docker:** apply floating version tag to every image build ([#125](https://github.com/navigaite/.github/issues/125)) ([c1fb2c5](https://github.com/navigaite/.github/commit/c1fb2c570dbc48b3301590485c632dc0fca4df3f))

## [2.8.0](https://github.com/navigaite/.github/compare/v2.7.0...v2.8.0) (2026-04-20)


### ✨ Features

* **release:** open release-please PRs in draft by default ([#123](https://github.com/navigaite/.github/issues/123)) ([3932560](https://github.com/navigaite/.github/commit/3932560d5e5812c27cf65f50a37d82aa202f1a3e))


### ⚡ Performance Improvements

* **ci:** merge pipeline-summary + inner check-gate into one job ([#122](https://github.com/navigaite/.github/issues/122)) ([ec4f4a0](https://github.com/navigaite/.github/commit/ec4f4a07853973e94f4f61a0350e2baddd117130))
* **ci:** skip security + lint on docs-only PRs ([#121](https://github.com/navigaite/.github/issues/121)) ([f423878](https://github.com/navigaite/.github/commit/f4238784189ff443e277c8a7c1b4ba97bfb07d38))
* **ci:** weekly nightly maintenance + drop dependency-check ([#120](https://github.com/navigaite/.github/issues/120)) ([74741b0](https://github.com/navigaite/.github/commit/74741b0d101b45b83a7d3d48bb66676f635666d0))
* **claude-code:** cancel in-flight runs on the same PR ([#119](https://github.com/navigaite/.github/issues/119)) ([7e1e2b7](https://github.com/navigaite/.github/commit/7e1e2b7d68ff0549bc42d7c936fde484e17c01b9))


### 📚 Documentation

* sync README, getting-started, configuration to v2.7.0 ([#118](https://github.com/navigaite/.github/issues/118)) ([cbc8126](https://github.com/navigaite/.github/commit/cbc8126b9aca6d139a85a2d0479de070afb2e5ca))

## [2.7.0](https://github.com/navigaite/.github/compare/v2.6.9...v2.7.0) (2026-04-20)


### ✨ Features

* **ci:** skip test/build/deploy on docs-only PRs ([#116](https://github.com/navigaite/.github/issues/116)) ([b87fc0d](https://github.com/navigaite/.github/commit/b87fc0dee9e8aa568aebe4ecd06a6bceb00c9c87))

## [2.6.9](https://github.com/navigaite/.github/compare/v2.6.8...v2.6.9) (2026-04-20)


### ⚡ Performance Improvements

* **ci:** cache turborepo outputs across runs ([#114](https://github.com/navigaite/.github/issues/114)) ([b90f493](https://github.com/navigaite/.github/commit/b90f4938af3444023ad0901adb64f457c9fed13b))

## [2.6.8](https://github.com/navigaite/.github/compare/v2.6.7...v2.6.8) (2026-04-20)


### ⚡ Performance Improvements

* **ci:** drop redundant global pnpm install ([#112](https://github.com/navigaite/.github/issues/112)) ([4add0d1](https://github.com/navigaite/.github/commit/4add0d1f38f5d8e9844e940d0df36e2475760b7a))

## [2.6.7](https://github.com/navigaite/.github/compare/v2.6.6...v2.6.7) (2026-04-20)


### 🐛 Bug Fixes

* **claude-code:** shrink repost comment, queue instead of cancel ([#109](https://github.com/navigaite/.github/issues/109)) ([ac58b45](https://github.com/navigaite/.github/commit/ac58b455470f4a12a3059465868a9a07ff914b2d))

## [2.6.6](https://github.com/navigaite/.github/compare/v2.6.5...v2.6.6) (2026-04-19)


### 🐛 Bug Fixes

* **pipeline:** mint release app token in-job so release-please PRs trigger CI ([#101](https://github.com/navigaite/.github/issues/101)) ([6069ef7](https://github.com/navigaite/.github/commit/6069ef74b80ff54d1fafe453362c083f17a6ceb3))

## [2.6.5](https://github.com/navigaite/.github/compare/v2.6.4...v2.6.5) (2026-04-18)


### 🐛 Bug Fixes

* **ci:** repost Copilot reviews as [@claude](https://github.com/claude) comments ([#99](https://github.com/navigaite/.github/issues/99)) ([bf6d42e](https://github.com/navigaite/.github/commit/bf6d42e8460839288d1f6775ae85e89b65129b9c))

## [2.6.4](https://github.com/navigaite/.github/compare/v2.6.3...v2.6.4) (2026-04-16)


### 🐛 Bug Fixes

* **claude-code:** pass prompt for bot reviews to enable automation mode ([#97](https://github.com/navigaite/.github/issues/97)) ([f22bd76](https://github.com/navigaite/.github/commit/f22bd763127ee0df9c735a2656bcd231db936f09))

## [2.6.3](https://github.com/navigaite/.github/compare/v2.6.2...v2.6.3) (2026-04-15)


### 🐛 Bug Fixes

* **claude-code:** whitelist Copilot for bot-triggered permission check ([#94](https://github.com/navigaite/.github/issues/94)) ([f8f7522](https://github.com/navigaite/.github/commit/f8f7522be0b7ca3f35af5c9f14f530fdb31fd415))

## [2.6.2](https://github.com/navigaite/.github/compare/v2.6.1...v2.6.2) (2026-04-15)


### 🐛 Bug Fixes

* **claude-code:** mint app token for bot-triggered runs ([#92](https://github.com/navigaite/.github/issues/92)) ([5c14eab](https://github.com/navigaite/.github/commit/5c14eabdc2fdf32f6862c73dc9787d71fb639c45))

## [2.6.1](https://github.com/navigaite/.github/compare/v2.6.0...v2.6.1) (2026-04-15)


### 🐛 Bug Fixes

* **ci:** align reusable pipeline contract ([#90](https://github.com/navigaite/.github/issues/90)) ([92dec7a](https://github.com/navigaite/.github/commit/92dec7a67b8ed7958bc2d6ed8becd77eb2399d20))

## [2.6.0](https://github.com/navigaite/.github/compare/v2.5.3...v2.6.0) (2026-04-15)


### ✨ Features

* **bootstrap:** pipeline compliance audit in bootstrap PRs ([#86](https://github.com/navigaite/.github/issues/86)) ([9d45329](https://github.com/navigaite/.github/commit/9d45329f327d356212f6e6032bd3134708c12184))

## [2.5.3](https://github.com/navigaite/.github/compare/v2.5.2...v2.5.3) (2026-04-15)


### 🐛 Bug Fixes

* **claude-code:** grant id-token: write for OIDC ([#87](https://github.com/navigaite/.github/issues/87)) ([faef765](https://github.com/navigaite/.github/commit/faef765d02e409ff91262b70990dd8f7ab8172ee))

## [2.5.2](https://github.com/navigaite/.github/compare/v2.5.1...v2.5.2) (2026-04-15)


### 🐛 Bug Fixes

* **templates:** pick up Copilot review fixes from [#82](https://github.com/navigaite/.github/issues/82) ([#83](https://github.com/navigaite/.github/issues/83)) ([9bf571c](https://github.com/navigaite/.github/commit/9bf571cd24fdff0169927a53ee954fa4a0ed966d))

## [2.5.1](https://github.com/navigaite/.github/compare/v2.5.0...v2.5.1) (2026-04-15)


### 🐛 Bug Fixes

* **bootstrap:** trunk caller uses distinct path to avoid collision ([#79](https://github.com/navigaite/.github/issues/79)) ([225892e](https://github.com/navigaite/.github/commit/225892e7a76fd37026ad82cd1f0ad8e1aedce470))

## [2.5.0](https://github.com/navigaite/.github/compare/v2.4.3...v2.5.0) (2026-04-15)


### ✨ Features

* **bootstrap:** manage claude-code caller workflow per repo ([#74](https://github.com/navigaite/.github/issues/74)) ([7d7c4dd](https://github.com/navigaite/.github/commit/7d7c4dd40c00ff22d6cec821ceb91f2d2068d373))


### 📚 Documentation

* unify agent guidance into AGENTS.md, link from CLAUDE.md ([#75](https://github.com/navigaite/.github/issues/75)) ([0799f83](https://github.com/navigaite/.github/commit/0799f830d7d43bfc0d9256c3574959eed78c076c))

## [2.4.3](https://github.com/navigaite/.github/compare/v2.4.2...v2.4.3) (2026-04-15)


### 🐛 Bug Fixes

* **claude-code:** permissive trigger filter + always-on diagnostics ([#73](https://github.com/navigaite/.github/issues/73)) ([f7e5b0d](https://github.com/navigaite/.github/commit/f7e5b0da6cd28f8dba1f8f1ea60841c6f21200c8))

## [2.4.2](https://github.com/navigaite/.github/compare/v2.4.1...v2.4.2) (2026-04-14)


### 🐛 Bug Fixes

* **templates:** grant caller-level permissions for trunk-upgrade ([#71](https://github.com/navigaite/.github/issues/71)) ([2c38cd9](https://github.com/navigaite/.github/commit/2c38cd9741ddfc681d4f7759f14dda182b1e7d8b))

## [2.4.1](https://github.com/navigaite/.github/compare/v2.4.0...v2.4.1) (2026-04-14)


### 🐛 Bug Fixes

* **scripts:** bootstrap handles new files and skips .github repo ([#69](https://github.com/navigaite/.github/issues/69)) ([e633310](https://github.com/navigaite/.github/commit/e633310bedf546c49bb9148507d0da7728f27bd6))

## [2.4.0](https://github.com/navigaite/.github/compare/v2.3.4...v2.4.0) (2026-04-14)


### ✨ Features

* **maintenance:** org-wide auto-upgrade bootstrap ([#66](https://github.com/navigaite/.github/issues/66)) ([1dd979c](https://github.com/navigaite/.github/commit/1dd979c6883ba4b5d5db567f09e3b73677b353a5))

## [2.3.4](https://github.com/navigaite/.github/compare/v2.3.3...v2.3.4) (2026-04-14)


### 🐛 Bug Fixes

* **claude-code:** use correct Copilot reviewer bot login ([#64](https://github.com/navigaite/.github/issues/64)) ([7242685](https://github.com/navigaite/.github/commit/7242685dc219d6937c5c9ac6387b729d05bdd23a))

## [2.3.3](https://github.com/navigaite/.github/compare/v2.3.2...v2.3.3) (2026-04-14)


### 🐛 Bug Fixes

* use GitHub App token for rolling tag updates ([#61](https://github.com/navigaite/.github/issues/61)) ([d1ea276](https://github.com/navigaite/.github/commit/d1ea276ef6e911939548a2e4270b6b1185177af6))

## [2.3.2](https://github.com/navigaite/.github/compare/v2.3.1...v2.3.2) (2026-04-14)


### 🐛 Bug Fixes

* **ci:** rename workflow to match org ruleset and remove unused workflow ([#59](https://github.com/navigaite/.github/issues/59)) ([9673881](https://github.com/navigaite/.github/commit/9673881f2af5bcffda73e1564b8fb4452d3ff99b))

## [2.3.1](https://github.com/navigaite/.github/compare/v2.3.0...v2.3.1) (2026-04-14)


### 🐛 Bug Fixes

* address security review findings ([#57](https://github.com/navigaite/.github/issues/57)) ([0fe0110](https://github.com/navigaite/.github/commit/0fe01109e77c31d3c8e31e5971f9a405cf75acab))

## [2.3.0](https://github.com/navigaite/.github/compare/v2.2.4...v2.3.0) (2026-04-14)


### ✨ Features

* add Claude Code workflow + fix blocked auto-merge ([#54](https://github.com/navigaite/.github/issues/54)) ([5cfe470](https://github.com/navigaite/.github/commit/5cfe47046be04eb1197c333d1497b19b7f330c44))

## [2.2.4](https://github.com/navigaite/.github/compare/v2.2.3...v2.2.4) (2026-04-14)


### 🐛 Bug Fixes

* add actions:read permission to security-audit job ([c8b66bd](https://github.com/navigaite/.github/commit/c8b66bd7be7c81c43f4f4bee45c966f956a9a3ce))
* add CI workflow with correct required check names ([#55](https://github.com/navigaite/.github/issues/55)) ([4fdc1fc](https://github.com/navigaite/.github/commit/4fdc1fc791a205357932d4daffe4f6e11faed18f))


### 📚 Documentation

* add comprehensive branching and release strategy to CLAUDE.md ([c2e7f66](https://github.com/navigaite/.github/commit/c2e7f669d01fda4543a3d6db3737e02c50a0ddbb))
* add default branch guidance to branching strategy ([f279713](https://github.com/navigaite/.github/commit/f279713a8424cec3d7409be496e5d33114d66b5d))

## [2.2.3](https://github.com/navigaite/.github/compare/v2.2.2...v2.2.3) (2026-04-08)


### 🐛 Bug Fixes

* **release:** check both App secrets before generating token ([#46](https://github.com/navigaite/.github/issues/46)) ([46d7fe4](https://github.com/navigaite/.github/commit/46d7fe46dba15f3132178e81d9d5daaaf2822230))

## [2.2.2](https://github.com/navigaite/.github/compare/v2.2.1...v2.2.2) (2026-04-08)


### 🐛 Bug Fixes

* preserve prerelease suffix in release version ([#42](https://github.com/navigaite/.github/issues/42)) ([d529c8e](https://github.com/navigaite/.github/commit/d529c8e85de018e499e9892a3e5db4284cae2cd4))

## [2.2.1](https://github.com/navigaite/.github/compare/v2.2.0...v2.2.1) (2026-04-08)


### 📚 Documentation

* add consumer setup guide, clean up deploy conditions ([#41](https://github.com/navigaite/.github/issues/41)) ([7c6be34](https://github.com/navigaite/.github/commit/7c6be34ea1d86d0cb287afbc74299bfd6ce0ca72))

## [2.2.0](https://github.com/navigaite/.github/compare/v2.1.2...v2.2.0) (2026-04-08)


### ✨ Features

* support separate release config for stable vs prerelease branches ([#36](https://github.com/navigaite/.github/issues/36)) ([a80cdda](https://github.com/navigaite/.github/commit/a80cdda3c22b7a45a858b32684a0519bbf569f62))


### 🐛 Bug Fixes

* **release:** find open release PR when release-please output is empty ([#40](https://github.com/navigaite/.github/issues/40)) ([64d880a](https://github.com/navigaite/.github/commit/64d880af1447bdd07cdc83e104c27fa80b2936c6))


### 📚 Documentation

* add AI agent instructions, fix release-please v4 inputs ([#38](https://github.com/navigaite/.github/issues/38)) ([56819f6](https://github.com/navigaite/.github/commit/56819f673bc83c1694a712a578f3c55a0bcd5445))

## [2.1.2](https://github.com/navigaite/.github/compare/v2.1.1...v2.1.2) (2026-04-08)


### 🐛 Bug Fixes

* **deps:** update stale action versions, fix DigitalOcean v2 migration ([#34](https://github.com/navigaite/.github/issues/34)) ([d78bd40](https://github.com/navigaite/.github/commit/d78bd406a22a7c6d10ca411647ffc7deb54bc66b))

## [2.1.1](https://github.com/navigaite/.github/compare/v2.1.0...v2.1.1) (2026-04-08)


### 🐛 Bug Fixes

* **pipeline:** fix sync job showing raw expression in name ([#32](https://github.com/navigaite/.github/issues/32)) ([3316ca0](https://github.com/navigaite/.github/commit/3316ca0fb0fd4841f768eba485be8d7604a90717))
* **pipeline:** rename to Navigaite CI/CD, fix deploy job names ([#30](https://github.com/navigaite/.github/issues/30)) ([08f9460](https://github.com/navigaite/.github/commit/08f9460a59213774f861355b5c5985e3756e15d2))
* **release:** remove component prefix from tags, add latest tag ([#29](https://github.com/navigaite/.github/issues/29)) ([b0c79c2](https://github.com/navigaite/.github/commit/b0c79c2cf41db647096c9791bec0c9eec9dc5208))


### 📚 Documentation

* modernize README with badges, version, and cleaner layout ([#27](https://github.com/navigaite/.github/issues/27)) ([626099f](https://github.com/navigaite/.github/commit/626099f4c141060a3e28eb58205db00fb565beca))

## [2.1.0](https://github.com/navigaite/.github/compare/navigaite-github-v2.0.0...navigaite-github-v2.1.0) (2026-04-08)


### ✨ Features

* **actions:** add setup action for Node.js environment ([977bda1](https://github.com/navigaite/.github/commit/977bda160ca422afe34f1075778dbd05b8f8baaf))
* **actions:** harden security, reliability, and DX across all actions and workflows ([02d4247](https://github.com/navigaite/.github/commit/02d42476c3f953f387de3b8c9a35aebf4104f079))
* add manifest mode and prerelease support to release-management action ([e888837](https://github.com/navigaite/.github/commit/e888837137b87271797dbde64d03fabde90a5272))
* add prerelease branch and manifest mode support to universal pipeline ([d88bdd8](https://github.com/navigaite/.github/commit/d88bdd8ac2dd30e4129f929795e142d51f4f4dc4))
* add render deploy action ([2011914](https://github.com/navigaite/.github/commit/201191440ab02a34756a9c6cab25a17f5db2026f))
* add reusable build-executable action and workflow ([9891257](https://github.com/navigaite/.github/commit/98912579eab6ef408b460761d69841107b849e49))
* add semver release flow, fix security issues and inconsistencies ([d5b469a](https://github.com/navigaite/.github/commit/d5b469a2d779ceb3036a3365df41f4e17e6edeae))
* added pr validation and code validation to release deployment. ([478baf4](https://github.com/navigaite/.github/commit/478baf42db4addb531a46a372a866b9a9be09663))
* added workflows ([023609e](https://github.com/navigaite/.github/commit/023609e262bbf1007c958904eba6692f6dd0af54))
* changed release pr deployment version ([a503205](https://github.com/navigaite/.github/commit/a503205047e8795e6939824cbdb82803080748f9))
* changed trunk to main branch ([ffa634d](https://github.com/navigaite/.github/commit/ffa634d38cf879d21c7e237ed0737fba1a1d167d))
* **ci:** integrate Infisical secrets-action via OIDC ([9795fa8](https://github.com/navigaite/.github/commit/9795fa816c6c72c36138d230591274cf8fe5beba))
* **ci:** run trunk-action for repos with .trunk config ([703b15a](https://github.com/navigaite/.github/commit/703b15a9cae2b76d9dd42295a888c9f794a69d0a))
* **ci:** streamline summaries and harden vercel deployment links ([9f7767e](https://github.com/navigaite/.github/commit/9f7767e2a549f4a7ccfa45e96d81ecbd04444b04))
* **ci:** strict lockfile-based dependency cache mode ([b57360c](https://github.com/navigaite/.github/commit/b57360ca344a4850b1cbad8fcebed6246fe7ad7c))
* **ci:** use Infisical universal auth in build workflow ([c71ffdd](https://github.com/navigaite/.github/commit/c71ffdd19ee048cef09040fc15b4a52324364b8c))
* **github:** add test.json for release categories and commit template ([ef62ca0](https://github.com/navigaite/.github/commit/ef62ca042e26c031a71b0de2dbf37cd72bb15303))
* **pipeline:** add multi-image Docker support and expose release outputs ([8e0180a](https://github.com/navigaite/.github/commit/8e0180ada5fdcdb70129aa7b6c7d8997606292a9))
* pr-validation and code-validation run on PR Change and Ready for review. ([ea2feb6](https://github.com/navigaite/.github/commit/ea2feb666e5a9c42444280f93ad270dddb941ef3))
* prerelease branch and manifest mode support ([c983da6](https://github.com/navigaite/.github/commit/c983da6456e816f5d3897476799f08455150fabd))
* **release:** add configuration for GitHub release action ([32909a5](https://github.com/navigaite/.github/commit/32909a591cec53e3954769f2a041ae199e2eb83b))
* **release:** add extra-plugins support for semantic-release ([7ef8187](https://github.com/navigaite/.github/commit/7ef8187114221a6a830e42f752d59e5fb13c5540))
* **release:** add release-please workflow with major tag automation ([dc76a65](https://github.com/navigaite/.github/commit/dc76a65b430355b6d160d68e74e2910fd06ab65a))
* **summaries:** modernize all job summary layouts ([f2f72aa](https://github.com/navigaite/.github/commit/f2f72aae323d5b656d8a1583031e3741d028c4ca))
* **workflow:** add input for optional back-merge PR creation ([b8dcdd9](https://github.com/navigaite/.github/commit/b8dcdd965907bd2d6ffd7cf4dd17e13bfa808db6))
* **workflow:** add new categories for release notes ([eb9c454](https://github.com/navigaite/.github/commit/eb9c4548eb77c5425a16132500302d900377281f))
* **workflows:** add comprehensive CI/CD workflows for NextJS projects ([b709a30](https://github.com/navigaite/.github/commit/b709a30b4ceea418e9a337d6e4df9c68c888a3a7))
* **workflows:** enhance step descriptions with emojis for clarity ([ec343aa](https://github.com/navigaite/.github/commit/ec343aaa4e06917ee9c78f1b7a31f448a7e2573c))


### 🐛 Bug Fixes

* actions ([7cfb589](https://github.com/navigaite/.github/commit/7cfb58933e30db240eecdde4ae1582a14dba2ea4))
* actions ([e983426](https://github.com/navigaite/.github/commit/e9834261834c723ba3c24b8d045b5b61e6c31768))
* changed user.email for the github app ([2299954](https://github.com/navigaite/.github/commit/22999541354049d80e3f1431a50f2472082449b1))
* **ci:** auto-install trunk when lint script requires it ([0c05e0a](https://github.com/navigaite/.github/commit/0c05e0a0d1cabfac21fea4881239becfc15f446e))
* **ci:** avoid requiring checks permission for trunk lint ([f0457f8](https://github.com/navigaite/.github/commit/f0457f8e3fb440ccec3d25050999137b08165b6d))
* **ci:** avoid secrets context in step if for Infisical ([6ae7f76](https://github.com/navigaite/.github/commit/6ae7f76fb7edd03cb060712988e9a9b6015d52e9))
* **ci:** default stack to auto and compact deploy outputs ([f73c865](https://github.com/navigaite/.github/commit/f73c8659cc5d0c40eb239f7d7bd6cc73c787ef3c))
* **ci:** load Infisical secrets in deploy job ([8443ed8](https://github.com/navigaite/.github/commit/8443ed836a5a51d505b9f6d88a3dc7ff0a29f769))
* **ci:** propagate detected node version across pipeline jobs ([f1d2994](https://github.com/navigaite/.github/commit/f1d2994d92efea4f05f265e12114eef2b308c4e4))
* **ci:** reduce noisy warnings and speed up provider deploy jobs ([d4f2ad1](https://github.com/navigaite/.github/commit/d4f2ad14bdbc63f5f5b53fb976fabcb49648fa14))
* **ci:** remove fetch-depth option from checkout action ([5eaf54d](https://github.com/navigaite/.github/commit/5eaf54d46eaca9e3749cdfa400498e0c079622b5))
* **ci:** remove unsupported setup-node input ([0d05890](https://github.com/navigaite/.github/commit/0d058901e6f154460d0445d30492d27f7ebf0656))
* **ci:** retry npm ci on transient registry failures ([c4f06cf](https://github.com/navigaite/.github/commit/c4f06cf050b163dff53e2aaad5e9d35555910b2d))
* **ci:** rewrite test-actions to fix workflow parse failure ([#26](https://github.com/navigaite/.github/issues/26)) ([2cd4b31](https://github.com/navigaite/.github/commit/2cd4b3190969cb08033a84e9659954e44b41ebce))
* **ci:** use fully qualified action refs in universal pipeline ([daf3055](https://github.com/navigaite/.github/commit/daf30553c1360c7d3708f1e07c3372bf289df5d8))
* **dependabot:** remove team assignees (unsupported by GitHub) ([5f9ff05](https://github.com/navigaite/.github/commit/5f9ff05f6277b8c22f1c094ecae8013634b2bfd6))
* **deps:** align all action versions (checkout v6.0.2, github-script v8.0.0) ([4f18f57](https://github.com/navigaite/.github/commit/4f18f573b8b609d5b0d1aeca9e6d44cf3418371f))
* get repo name from github context ([092d507](https://github.com/navigaite/.github/commit/092d50709fe5afdbc6e15bc11ff16ba8b52b3111))
* gitignore update ([a3e1ef5](https://github.com/navigaite/.github/commit/a3e1ef59249289a03fc487f2f85ea51cb2843387))
* new env ([2e40ff8](https://github.com/navigaite/.github/commit/2e40ff816af73c471e3f0cffa3ff1da0636b5d2a))
* **pipeline:** compact docker-images JSON output for GITHUB_OUTPUT ([54a5f73](https://github.com/navigaite/.github/commit/54a5f73b4c41a3b1775497ecf530851c859f11ba))
* **pipeline:** disable caching in setup job to prevent pnpm store path error ([3c68e0c](https://github.com/navigaite/.github/commit/3c68e0ca6c034f91584264106e646c0d1de658c2))
* **pipeline:** gate sync-to-dev on release-created output ([5b784ba](https://github.com/navigaite/.github/commit/5b784ba75ff772343dd2d9cb5831dfe563b9a6a4))
* **release:** remove release-as lock, add manifest, add package version ([6fa215f](https://github.com/navigaite/.github/commit/6fa215fb75a2bbf91e654fa1c96711b8d27d12c0))
* **scan-pr:** specify read and write permissions for contents and pull-requests ([b4cba1c](https://github.com/navigaite/.github/commit/b4cba1cf5d8eb7928950ed53e7b7d3ece6222ea3))
* **security:** eliminate shell injection in create-release-pr ([6cf87c1](https://github.com/navigaite/.github/commit/6cf87c1417d7f178646db669a368e25cb61e4ced))
* **setup-environment:** install pnpm before using it for Node.js caching ([93d813e](https://github.com/navigaite/.github/commit/93d813e0d4bd8472e4e08c75c521f7bf6409b9f4))
* use nvmrc file for node setup ([170b6f2](https://github.com/navigaite/.github/commit/170b6f208802809c7e034a6c217f3ef9cd1a7fe9))
* **vercel:** map all non-prod deploys to preview target ([96383f7](https://github.com/navigaite/.github/commit/96383f733b3a43770d31d4fd3db956c98d1bd343))
* **vercel:** use dashboard URL for summary link to avoid secret masking breakage ([c9cba7f](https://github.com/navigaite/.github/commit/c9cba7f007ee1244ce5f732ab2a503bc66a7eb8b))
* **workflow:** add permissions to code-review job in sub-scan-pr.yaml ([0803abc](https://github.com/navigaite/.github/commit/0803abcaf4b1d0ccedd18bdbbaacb8541d2b0e94))
* **workflow:** adjust permissions for contents and pull-requests ([01dbfe4](https://github.com/navigaite/.github/commit/01dbfe4121c197184d058bce554cd5590a0f9772))
* **workflow:** correct label formatting in back-merge PR title and labels ([eb9c454](https://github.com/navigaite/.github/commit/eb9c4548eb77c5425a16132500302d900377281f))
* **workflow:** ensure back-merge job runs conditionally based on input ([b8dcdd9](https://github.com/navigaite/.github/commit/b8dcdd965907bd2d6ffd7cf4dd17e13bfa808db6))
* **workflow:** remove redundant environment variable 'DOTENV_KEY' ([dca053e](https://github.com/navigaite/.github/commit/dca053e6fab9fe1cf8b6278c644d6806f04f935f))
* **workflows:** move permissions to top level in 'sub-create-release.yaml' and 'sub-draft-new-release.yaml' ([ea2ab1b](https://github.com/navigaite/.github/commit/ea2ab1b8c2eb48602c873e12bc168212e0740f6b))
* **workflows:** replace single quotes with double quotes for consistency ([f903b79](https://github.com/navigaite/.github/commit/f903b796a5667fc3a91340e04ef2497e9123b93a))
* **workflows:** update cron schedule and workflow dispatch comments ([ec343aa](https://github.com/navigaite/.github/commit/ec343aaa4e06917ee9c78f1b7a31f448a7e2573c))
* **workflow:** update checkout action to v4 with fetch-depth 0 ([c1c0121](https://github.com/navigaite/.github/commit/c1c0121ba2a82cb44ad0dd7e95828d15d131893e))
* **workflow:** update permissions for sub-linting workflow ([54b9003](https://github.com/navigaite/.github/commit/54b900394b41ffe626bb14d9981a0a51d836f4ab))
* **workflow:** update permissions for sub-scan-pr.yaml ([0803abc](https://github.com/navigaite/.github/commit/0803abcaf4b1d0ccedd18bdbbaacb8541d2b0e94))
* **workflow:** update permissions to allow write access to pull-requests ([20ba90d](https://github.com/navigaite/.github/commit/20ba90d520dff7551d4f8430c8b198278b38aba7))
* **workflow:** update release workflow to use new action-gh-release-config ([a1bf9fd](https://github.com/navigaite/.github/commit/a1bf9fd14c33e2e24cbdcedb9680479429fef5c6))


### 📚 Documentation

* add guide for using workflows from other repositories ([6991dfa](https://github.com/navigaite/.github/commit/6991dfa8460c4dcbc5830580de7ea7f4a206d1a8))
* add migration and cross-repo usage guides ([977bda1](https://github.com/navigaite/.github/commit/977bda160ca422afe34f1075778dbd05b8f8baaf))
* rewrite README with release flow, fix stale content ([53a5d55](https://github.com/navigaite/.github/commit/53a5d550cd982b7cd973cf719f96c3e03a05303e))
* update README with setup action usage and deprecation notice ([977bda1](https://github.com/navigaite/.github/commit/977bda160ca422afe34f1075778dbd05b8f8baaf))


### ♻️ Code Refactoring

* **ci:** remove custom setup action and replace with reusable workflow ([c5f4b5f](https://github.com/navigaite/.github/commit/c5f4b5f2c567d6c10a5aae0b24a9a1e70ceed178))
* **workflow:** remove conditional check for pull request merge ([c1c0121](https://github.com/navigaite/.github/commit/c1c0121ba2a82cb44ad0dd7e95828d15d131893e))
* **workflow:** remove redundant comments on permissions ([01dbfe4](https://github.com/navigaite/.github/commit/01dbfe4121c197184d058bce554cd5590a0f9772))
* **workflows:** consolidate and update GitHub Actions workflows ([d38c341](https://github.com/navigaite/.github/commit/d38c3417cd9f101da93d33e54618da1041870a8d))
* **workflows:** consolidate and update GitHub Actions workflows ([bdf1e1e](https://github.com/navigaite/.github/commit/bdf1e1e4daee4c21560b900760e80ccede352fc6))
* **workflows:** replace sub-setup workflow with new setup action ([977bda1](https://github.com/navigaite/.github/commit/977bda160ca422afe34f1075778dbd05b8f8baaf))
* **workflows:** update Vercel deployment action and standardize naming conventions ([f903b79](https://github.com/navigaite/.github/commit/f903b796a5667fc3a91340e04ef2497e9123b93a))
* **workflows:** use double quotes for consistency in run-name and PR_PREVIEW_DOMAIN ([ec343aa](https://github.com/navigaite/.github/commit/ec343aaa4e06917ee9c78f1b7a31f448a7e2573c))

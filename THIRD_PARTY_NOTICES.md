# Third-party notices

## Lume / Cua

This project invokes Lume but does not bundle its executable. Golden Gate first-login preference keys and the build/product stamp encodings in `guest.mjs` are adapted from the investigation and implementation in [trycua/cua PR #4027](https://github.com/trycua/cua/pull/4027), reviewed at commit `3593519151d3e02ee32a90803f869df43fb65c93`. The auto-login password-file format also follows the documented implementation in Lume. This is not an upstream Lume release and does not imply that an open PR has been merged.

Upstream license: https://github.com/trycua/cua/blob/main/LICENSE.md

```text
MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## vncdotool

The optional relay depends on [vncdotool](https://github.com/sibson/vncdotool) 1.4.2 by the vncdotool contributors, under the [MIT license](https://github.com/sibson/vncdotool/blob/v1.4.2/LICENSE.txt). No upstream library source is copied or bundled here. The relay subclasses its client to retain resized framebuffer request dimensions and handle valid empty updates. Dependencies installed separately retain their own licenses, including Pillow, Twisted and cryptography.

## Other software

Node.js, macOS, Apple's Virtualization framework, Tailscale, OpenCode, Claude Code, and optional `vncdotool` have their own licenses and terms. They are not relicensed or bundled by this repository. In particular, this MIT license does not grant rights to redistribute a macOS restore image or bypass Apple's software-license requirements.

# Plinglist Trademark & Brand Assets Policy

**Last Updated:** November 2026  
**Owner:** Daniel Notthoff ([plinglist.com](https://plinglist.com) / [goork.de](https://goork.de))

While the **Plinglist** core client and self-hosted sync server source code is publicly available under the [GNU Affero General Public License v3.0 (AGPLv3)](LICENSE), **the AGPLv3 does not grant any rights to use the Plinglist trademarks, service marks, trade names, slogans, logos, app icons, promotional store graphics, or the original proprietary "Pling" audio signature** (see GNU AGPLv3, Section 7(e)).

This policy explains how you may and may not use the Plinglist brand, audio, and visual assets when forking, modifying, self-hosting publicly, or redistributing the source code.

---

## 1. Protected Trademarks, Audio & Visual Assets ("Brand Assets")

The following assets are the exclusive property of **Daniel Notthoff** (*All Rights Reserved*) and are **excluded** from the GNU AGPLv3 open-source license:

1. **Word Marks, Slogans & Identifiers:**
   - **"Plinglist"** and **"Plinglist Pro"**
   - The slogan **"Pling. Done. – The simple to-do list that stays."** (and **"Pling. Done."**)
   - The package and bundle identifiers **`de.goork.plinglist`** (Android `applicationId` and iOS Bundle IDs)
   - Official domain names including **`plinglist.com`**, **`plinglist.app`**, **`plinglist.de`**, **`plinglist.io`**, and all associated subdomains (`api.plinglist.app`, etc.)

2. **Audio Signature:**
   - The original proprietary **"Pling"** task-completion sound recording used in official Plinglist builds and on `plinglist.com` / `plinglist.app`.
   - *(Note: The public open-source repository ships with a neutral CC0/synthetic placeholder chime instead.)*

3. **Logos, App Icons & Promotional Graphics:**
   - The official Plinglist app icons, favicons, and vector drawables (`ic_launcher*`, `AppIcon.appiconset`, `favicon*`, `apple-touch-icon.png`)
   - Promotional graphics, feature graphics, and store screenshots

---

## 2. Requirements for Forks, Modified Versions & Public Deployments

If you fork, modify, compile, deploy publicly over a network, or redistribute this software (whether gratis or commercially, in source or binary form):

1. **Mandatory Rebranding:**
   - You **must remove and replace** the name **"Plinglist"** (and any confusingly similar variation such as *"Plinglist Free"*, *"Plinglist Mod"*, *"OpenPlinglist"*, or *"PlingToDo"*), the slogan *"Pling. Done."*, and any official app icons, logos, or promotional graphics before publishing binaries (e.g., on Google Play, Apple App Store, F-Droid, GitHub Releases) or operating a public multi-user SaaS instance.
   - You **must change** the Android `applicationId` and iOS Bundle Identifier from `de.goork.plinglist` to your own namespace.
   - Note: Private self-hosting for yourself, your household, or internal team use on your own domain/server does not constitute public redistribution, provided you do not present your instance as an official Plinglist service.

2. **No Implied Endorsement:**
   - You may not state or imply that your fork, modified build, or hosted instance is an official Plinglist release, or that it is endorsed, sponsored, or supported by Daniel Notthoff or Goork.

3. **No Unauthorized Use of Hosted Cloud Infrastructure:**
   - The open-source license covers the core client and self-hosted sync server source code only. It does **not** grant permission to connect third-party forks, modified builds, or automated scripts to the official hosted cloud infrastructure (`api.plinglist.app`, `plinglist.app`). Forks distributed to end users must change the default server URL to their own infrastructure or disable hosted sync.

---

## 3. Permitted Nominative Use

You may make truthful, descriptive textual references to **"Plinglist"** without prior written permission solely in the following contexts:

- Stating in your repository documentation or "About" screen that your project is *"a fork of the open-source Plinglist project"* or *"based on source code from Plinglist"*, provided that it is accompanied by a clear disclaimer that your project is unofficial and not affiliated with Plinglist.
- Editorial, journalistic, or community coverage (reviews, blog posts, tutorials) discussing the official Plinglist app.

---

## 4. Reporting & Questions

For press inquiries, permission requests, or trademark questions, please contact:  
**Daniel Notthoff** – [hey@goork.de](mailto:hey@goork.de)

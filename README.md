# Nortia AI Grab Connector

A small local connector that lets **your own Claude** collect new applicants'
resumes from **your own** hiring-platform account and send them into **your**
Nortia workspace. It runs on your computer as a local MCP server for Claude
Desktop; nothing is installed on Nortia's side.

Resumes arrive in Nortia → AI Grab Resume → Resume inbox. A resume whose job
title exactly matches one of your active jobs is assigned automatically; the
rest wait there for you to assign or close.

## Requirements

- Node.js 20 or newer
- A paid Claude plan and Claude Desktop (the **Code** tab)
- macOS (Windows coming)
- A Nortia workspace with AI Grab Resume turned on

## Install

Open **Nortia → AI Grab Resume → Connect**. That page generates install
instructions for your workspace; paste them into a new session in Claude
Desktop's Code tab and Claude sets everything up, including a daily scheduled
run. This repository deliberately carries no install steps of its own.

To stop: tell Claude "Disconnect Nortia from this Mac".

## Privacy

- Resume files and your Hiredly password never pass through the AI. Resumes are
  downloaded and sent to Nortia inside the connector process, in memory only,
  and are never written to disk.
- Your Hiredly password is typed into a macOS password dialog and stored in your
  Mac keychain; Claude only sees whether it was saved.
- Claude only sees counts (how many resumes were sent, matched or skipped) and a
  status sentence — never candidate names, emails or phone numbers.
- Your Nortia connector key passes through Claude once, when you paste the
  install instructions. It can only send resumes to your own workspace, and an
  admin can revoke it at any time in Nortia → AI Grab Resume → Keys.

## Roadmap

- Hiredly — available
- JobStreet — browser-driven, planned
- Windows — planned

## License

Source-available; see [LICENSE](LICENSE). The license text is pending legal
review.

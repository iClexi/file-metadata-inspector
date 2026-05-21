# File Metadata Inspector

![Node.js](https://img.shields.io/badge/Node.js-22-0b6bcb?style=for-the-badge&logo=node.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-12365f?style=for-the-badge&logo=postgresql&logoColor=white)
![Security](https://img.shields.io/badge/Secure%20Uploads-1GB%20Limit-111827?style=for-the-badge)
![Portfolio](https://img.shields.io/badge/Portfolio-Demo-1877f2?style=for-the-badge)

File Metadata Inspector is a portfolio-focused web application for extracting and editing technical metadata from uploaded files. The interface is intentionally scoped to one task: receive a file, analyze safe technical details, optionally write common metadata fields, and present or return the result without acting as file storage.

This repository demonstrates UI design, upload validation, backend file handling, PostgreSQL persistence for analysis records, direct metadata-edit downloads, and careful handling of file metadata without turning the project into a file hosting or sharing platform.

## Preview

Screenshots can be added here after a public visual pass:

- Desktop upload and result state
- Mobile upload flow
- Metadata result cards

## Highlights

- File-only metadata extraction flow.
- Frontend and backend validation for the 1 GB maximum file size.
- Streamed upload processing so full files are not written to disk.
- Direct metadata editing for common fields such as title, author, description, copyright, keywords, and comment.
- Edited files are returned as direct downloads from a temporary server copy, without public links or permanent storage.
- Technical metadata view for file name, size, extension, MIME type, analysis date, and type-specific details when detectable.
- Optional account sessions with HttpOnly cookies, active-device review, and session revocation.
- No public download links, shared URLs, or file hosting behavior.
- PostgreSQL schema focused on metadata analysis records, user sessions, and account-owned analysis history, not stored file contents.
- Responsive dark blue interface with rounded panels, clear status states, and mobile-friendly layouts.

## Technology

- Node.js native HTTP server
- Busboy for streaming multipart file uploads
- ExifTool for writing supported metadata fields
- PostgreSQL for metadata analysis records
- PBKDF2 password hashing and database-backed session tokens
- Anime.js for focused interface motion and file-selection feedback
- HTML, CSS, and JavaScript frontend
- Apache reverse proxy and systemd deployment files included as sanitized examples

## Security Posture

The uploaded file content is streamed, sampled for technical detection, and discarded. The database stores analysis metadata only. Sensitive runtime values are intentionally omitted from the repository and should live in environment-specific secret stores.

Configuration examples use placeholders only. Real credentials, private IPs, internal URLs, API keys, authentication secrets, and `.env` files are not part of this project.

## Portfolio Note

This repository is presented as a professional development sample. It is meant to show implementation quality, design direction, validation, and secure file-handling decisions. Private deployment details and production-specific configuration have been omitted by design.

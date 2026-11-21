/**
 * Optional. Turns emails in a support inbox into GitHub issues labeled "feedback",
 * which Nightshift reads on its next shift.
 *
 * This file has not been run against a real inbox yet. Try it on one email first.
 * Use it only with a private repository, because the email text becomes the issue text.
 * The sender's address is left out on purpose.
 *
 * Setup, at script.google.com while signed in to the support inbox:
 *   1. New project, paste this file, set REPO below.
 *   2. Project Settings > Script properties > add GITHUB_TOKEN
 *      (a fine-grained token with "Issues: read and write" on that one repository).
 *   3. Triggers > add a time trigger for `forward`, once an hour.
 */
const REPO = "owner/repo";
const QUERY = "is:unread newer_than:2d"; // narrow it if you like, for example: subject:(bug report)

function forward() {
  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  GmailApp.search(QUERY, 0, 20).forEach(function (thread) {
    const mail = thread.getMessages()[0];
    const res = UrlFetchApp.fetch("https://api.github.com/repos/" + REPO + "/issues", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      payload: JSON.stringify({
        title: mail.getSubject() || "Support email",
        body: mail.getPlainBody().slice(0, 4000),
        labels: ["feedback"],
      }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 201) thread.markRead();
  });
}

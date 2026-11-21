# Inbox

Drop anything here that Nightshift should look at on its next shift, then commit it.

- A support email pasted into a `.txt` or `.md` file.
- A chunk of logs saved as `.log`.
- A `.json` file with a list of reports, for example:

```json
[
  { "title": "Streak reset after travelling", "body": "Flew to another time zone and lost a 30 day streak.", "appVersion": "1.1.0" }
]
```

Each file is read once. When Nightshift has opened a pull request or an issue for it, it will not raise it again, so you can delete the file whenever you like.

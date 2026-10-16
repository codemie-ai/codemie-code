```json
[
{"kind":"acceptance","item":"HTTPS Bitbucket scm/PROJ/repo -> proj/repo","status":"pass","notes":"scm strip + lowercase; tested"},
{"kind":"acceptance","item":"HTTPS personal repo -> jdoe/repo","status":"pass","notes":"scm and ~ dropped; tested"},
{"kind":"acceptance","item":"SSH Bitbucket remotes -> proj/repo, jdoe/repo","status":"pass","notes":"tested"},
{"kind":"acceptance","item":"Whole result lower-cased","status":"pass","notes":"final toLowerCase; tested"},
{"kind":"acceptance","item":"~ elsewhere preserved","status":"pass","notes":"only leading char of first segment stripped; tested"},
{"kind":"acceptance","item":"org.visualstudio.com/Proj/_git/repo -> org/proj/repo","status":"pass","notes":"tested"},
{"kind":"acceptance","item":"DefaultCollection dropped","status":"pass","notes":"tested"},
{"kind":"acceptance","item":"vs-ssh.visualstudio.com v3 form","status":"pass","notes":"tested"},
{"kind":"acceptance","item":"dev.azure.com unchanged apart from lower-casing","status":"pass","notes":"tested"},
{"kind":"acceptance","item":"scm preserved on non-Bitbucket shapes","status":"pass","notes":"two-segment, SSH, non-leading tested"},
{"kind":"acceptance","item":"_git/v3 preserved on non-Azure hosts","status":"pass","notes":"tested"},
{"kind":"acceptance","item":"Unparseable remote behaviour unchanged","status":"partial","notes":"malformed %2 tested; https://example.com/ case has no test; lone '~' segment now yields empty segment"}
]
```

```markdown
- partial: unparseable-remote criterion; no test for https://example.com/, and a lone '~' segment yields an empty-string name.
```

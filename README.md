School Menu (Home Screens plugin)

Shows today's school breakfast/lunch from Health-e Pro (menus.healthepro.com).


Settings

Show the next school day after this hour (0 = off, default): e.g. `14` switches to
tomorrow's menu at 2 PM, skipping weekends, holidays and PD days (looks up to 14 days ahead,
across month boundaries). The date line reads "Tomorrow · ..." or "Next school day · ...".

Add the School Menu module to a screen, then pick your school and menu in its settings
(district ID defaults to 1031).

Try it
`node serve.js`
In the Home Screens editor open the Developer tab and paste `http://localhost:5555`

No build step: `dist/bundle.js` is hand-written and uses the host's React global.
`node test.js` runs offline tests with a mocked SDK.

Data source (unofficial, found by reading other open-source integrations)
`/api/organizations/{org}/sites/list`
`/api/organizations/{org}/sites/{site}/menus/`
`/api/organizations/{org}/menus/{menu}/year/{Y}/month/{M}/date\\\_overwrites`

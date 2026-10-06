-- The rename to Trov: the digest / invite / welcome SENDER. Only the untouched default changes — an admin's
-- own from_address is left alone. The new address is on trov.dev, so the Resend sending domain must be
-- trov.dev (verified) before this deploys; the app itself stays on canopy.saplinglearn.com for now.
UPDATE notification_settings
   SET from_address = 'Trov <hello@trov.dev>'
 WHERE from_address = 'Canopy <canopy@canopy.saplinglearn.com>';

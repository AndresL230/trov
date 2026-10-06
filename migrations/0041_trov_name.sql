-- The rename to Trov: the digest sender's DISPLAY name. Only the untouched default changes — an admin's own
-- from_address is left alone — and the address stays on canopy.saplinglearn.com (the domain move is a
-- separate, owner-run change: DNS, the Resend sending domain, the GitHub/Google OAuth redirect URLs).
UPDATE notification_settings
   SET from_address = 'Trov <canopy@canopy.saplinglearn.com>'
 WHERE from_address = 'Canopy <canopy@canopy.saplinglearn.com>';

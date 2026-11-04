-- A contact gets one message per campaign, even if two workers start the same campaign
DELETE FROM messages a USING messages b
  WHERE a.campaign_id IS NOT NULL AND a.campaign_id = b.campaign_id AND a.contact_id = b.contact_id AND a.ctid > b.ctid;
CREATE UNIQUE INDEX messages_campaign_contact ON messages(campaign_id, contact_id) WHERE campaign_id IS NOT NULL AND contact_id IS NOT NULL;

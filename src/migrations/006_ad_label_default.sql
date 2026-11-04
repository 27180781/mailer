-- Whether new campaigns get the word "פרסומת" added to the subject by default (Israeli anti-spam law)
ALTER TABLE accounts ADD COLUMN ad_label_default boolean NOT NULL DEFAULT true;

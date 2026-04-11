-- Enable Supabase Realtime on messages table for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- Enable Realtime on connected_accounts for status sync
ALTER PUBLICATION supabase_realtime ADD TABLE connected_accounts;

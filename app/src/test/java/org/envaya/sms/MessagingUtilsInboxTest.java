package org.envaya.sms;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.ContentProvider;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

import java.util.ArrayList;
import java.util.List;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;

/**
 * Unit tests for the Option-B inbound-SMS path (see upgrade-plan/11): reading received SMS rows from
 * the {@code content://sms/inbox} provider and turning them into forwardable IncomingSms objects.
 *
 * <p>A fake ContentProvider is registered on content://sms/inbox so the test runs deterministically
 * on the JVM without a device, mirroring how CheckMessagingService/MessagingObserver consume it.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class MessagingUtilsInboxTest {

    // _id (long), address (String), body (String), date (long, ms) — matches the query projection.
    private static final String[] COLUMNS = {"_id", "address", "body", "date"};

    private App app;
    private MessagingUtils utils;
    private FakeSmsInboxProvider provider;

    @Before
    public void setUp() {
        app = (App) RuntimeEnvironment.getApplication();
        provider = new FakeSmsInboxProvider();
        // Robolectric's ShadowContentResolver matches registered providers by URI authority, so the
        // key here is "sms" (the authority of content://sms/inbox), not the full path.
        ShadowContentResolver.registerProviderInternal("sms", provider);
        utils = new MessagingUtils(app);
    }

    @Test
    public void readsAndParsesInboxRows() {
        provider.rows.add(new Object[]{100L, "15551230000", "hello inbox", 1_700_000_000L});

        List<IncomingSms> messages = utils.getNewIncomingSmsFromInbox(true);

        assertEquals("one inbox row should be read", 1, messages.size());
        IncomingSms sms = messages.get(0);
        assertEquals(100L, sms.getMessagingId());
        assertEquals("15551230000", sms.getFrom());
        assertEquals("hello inbox", sms.getMessageBody());
        assertEquals(1_700_000_000L, sms.getTimestamp());
        // Received messages are direction=Incoming; isForwardable() then keys off the sender.
        assertEquals(IncomingSms.Direction.Incoming, sms.getDirection());
    }

    @Test
    public void doesNotReforwardAlreadySeenRows() {
        provider.rows.add(new Object[]{100L, "15551230000", "hello", 1L});

        // First read (newMessagesOnly) returns the row. The caller marks it seen, exactly as
        // CheckMessagingService does after forwarding.
        List<IncomingSms> first = utils.getNewIncomingSmsFromInbox(true);
        assertEquals(1, first.size());
        utils.markSeenIncomingSms(first.get(0));

        // Second read with newMessagesOnly=true should skip the already-seen row.
        assertTrue("newMessagesOnly reads must skip already-forwarded rows",
                utils.getNewIncomingSmsFromInbox(true).isEmpty());
    }

    @Test
    public void forceReadReturnsAllRowsRegardlessOfSeenSet() {
        provider.rows.add(new Object[]{100L, "15551230000", "first", 1L});
        provider.rows.add(new Object[]{200L, "15551230001", "second", 2L});

        // Mark only the first row as seen (as CheckMessagingService does after forwarding).
        utils.markSeenIncomingSms(utils.getNewIncomingSmsFromInbox(true).get(0));

        // newMessagesOnly=true skips already-seen rows...
        assertEquals("only the unmarked row should be returned", 1, utils.getNewIncomingSmsFromInbox(true).size());
        // ...but force read (newMessagesOnly=false) returns every row regardless of seen state.
        assertEquals(2, utils.getNewIncomingSmsFromInbox(false).size());
    }

    /** Serves a fixed in-memory list of inbox rows as a MatrixCursor. */
    static class FakeSmsInboxProvider extends ContentProvider {
        final List<Object[]> rows = new ArrayList<>();

        @Override
        public boolean onCreate() {
            return true;
        }

        @Override
        public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
                            String sortOrder) {
            MatrixCursor cursor = new MatrixCursor(COLUMNS);
            for (Object[] row : rows) {
                cursor.addRow(row);
            }
            return cursor;
        }

        @Override
        public String getType(Uri uri) {
            return null;
        }

        @Override
        public Uri insert(Uri uri, ContentValues values) {
            throw new UnsupportedOperationException();
        }

        @Override
        public int delete(Uri uri, String selection, String[] selectionArgs) {
            throw new UnsupportedOperationException();
        }

        @Override
        public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
            throw new UnsupportedOperationException();
        }
    }
}

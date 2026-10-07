package org.envaya.sms;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import java.io.File;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Persistence tests for {@link DatabaseHelper}, run on the JVM via Robolectric (which provides a
 * working embedded SQLite through its shadow of android.database.sqlite.*).
 *
 * <p>The headline case verifies Stage 10's core fix: upgrading an existing v4 database to v5 must
 * preserve both tables and every pending message row, instead of dropping them.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class DatabaseHelperTest {

    private DatabaseHelper helper;
    private SQLiteDatabase db;

    @Before
    public void setUp() throws Exception {
        // Use the application instance Robolectric built from the manifest (declares .App).
        Context context = RuntimeEnvironment.getApplication();

        // Start every test method from a clean database so state never leaks between tests.
        File dbFile = context.getDatabasePath(DatabaseHelper.DATABASE_NAME);
        if (dbFile.exists()) {
            dbFile.delete();
        }

        helper = new DatabaseHelper((App) context);
        // First open creates the schema at DATABASE_VERSION (5 after Stage 10).
        db = helper.getWritableDatabase();
    }

    @Test
    public void onUpgradePreservesPendingMessages() {
        // Rewind the freshly created DB to look like one written by the old app (version 4),
        // then exercise the v4 -> v5 upgrade path.
        db.execSQL("PRAGMA user_version = 4");

        insertIncoming(SMS, "15551230000", "incoming from v4");
        insertOutgoing(SMS, "15551231111", "outgoing while offline");

        // The v4 -> v5 upgrade must not drop the tables or their rows.
        helper.onUpgrade(db, 4, 5);

        assertTrue("incoming table should still exist", tableExists(PENDING_INCOMING));
        assertTrue("outgoing table should still exist", tableExists(PENDING_OUTGOING));
        assertEquals("pending incoming messages must survive upgrade", 1, countRows(PENDING_INCOMING));
        assertEquals("pending outgoing messages must survive upgrade", 1, countRows(PENDING_OUTGOING));
    }

    @Test
    public void freshInstallCreatesVersion5WithBothTables() {
        // First open creates the schema at DATABASE_VERSION (bumped to 5 in Stage 10).
        assertEquals("fresh DB should be created at version 5", 5, currentVersion());
        assertTrue(tableExists(PENDING_INCOMING));
        assertTrue(tableExists(PENDING_OUTGOING));
    }

    // --- helpers -----------------------------------------------------------------------------

    private static final String PENDING_INCOMING = "pending_incoming_messages";
    private static final String PENDING_OUTGOING = "pending_outgoing_messages";
    private static final String SMS = "sms";

    private void insertIncoming(String type, String from, String body) {
        db.execSQL(
                "INSERT INTO " + PENDING_INCOMING
                        + " (`message_type`, `messaging_id`, `from_number`, `to_number`, `message`, `direction`, `timestamp`) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
                new Object[]{type, -1, from, "15550000000", body, 1, 1_700_000_000L});
    }

    private void insertOutgoing(String type, String to, String body) {
        db.execSQL(
                "INSERT INTO " + PENDING_OUTGOING
                        + " (`message_type`, `from_number`, `to_number`, `message`, `priority`, `server_id`) "
                        + "VALUES (?, ?, ?, ?, ?, ?)",
                new Object[]{type, "15551112222", to, body, 0, "srv-42"});
    }

    private long countRows(String table) {
        try (Cursor c = db.rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            c.moveToFirst();
            return c.getLong(0);
        }
    }

    private boolean tableExists(String name) {
        String sql = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?";
        try (Cursor c = db.rawQuery(sql, new String[]{name})) {
            return c.moveToFirst();
        }
    }

    private int currentVersion() {
        try (Cursor c = db.rawQuery("PRAGMA user_version", null)) {
            c.moveToFirst();
            return c.getInt(0);
        }
    }
}

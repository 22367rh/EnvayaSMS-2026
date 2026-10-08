package org.envaya.sms.task;

import okhttp3.MediaType;

/**
 * A single file part of a multipart/form-data upload, replacing the old Apache
 * multipart form-part type. OkHttp's MultipartBuilder consumes
 * (name, filename, MediaType, byte[]) directly.
 */
public final class MultipartPart {

    private final String name;
    private final String filename;
    private final byte[] data;
    private final MediaType mediaType;

    public MultipartPart(String name, String filename, String contentType, byte[] data) {
        this.name = name;
        this.filename = filename;
        this.data = data;
        this.mediaType = (contentType == null || contentType.isEmpty())
                ? null
                : MediaType.parse(contentType);
    }

    public String getName() {
        return name;
    }

    public String getFilename() {
        return filename;
    }

    public byte[] getData() {
        return data;
    }

    public MediaType getMediaType() {
        return mediaType;
    }
}

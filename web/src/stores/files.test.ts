import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialFilesState, useFilesStore } from "./files";
import { useDaemonStore } from "./daemon";
import { officialApi } from "../api/official";
import { parseOfficialUtcTime } from "../lib/format";

/** 与 daemon/sau_backend.py::get_all_files 返回的 file_records 行结构一致（含 uuid 派生字段）。 */
const FILE_A = {
  id: 1,
  filename: "demo.mp4",
  filesize: 12.5,
  upload_time: "2026-08-18 10:00:00",
  file_path: "6f2f49180cf24f17003ab7f50be5b098_demo.mp4",
  uuid: "6f2f49180cf24f17003ab7f50be5b098",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe("files store（官方素材库）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:5409" });
    useFilesStore.setState(initialFilesState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchFiles 成功 -> 解析官方 {code,data} 结构并填充列表", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 200, msg: "success", data: [FILE_A] }),
      ),
    );

    await useFilesStore.getState().fetchFiles();

    const s = useFilesStore.getState();
    expect(s.files).toEqual([FILE_A]);
    expect(s.error).toBe("");
  });

  it("fetchFiles 失败（非 200 code）-> 记录官方 msg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 500, msg: "get file failed!", data: null }, true, 200),
      ),
    );

    await useFilesStore.getState().fetchFiles();

    expect(useFilesStore.getState().files).toEqual([]);
    expect(useFilesStore.getState().error).toContain("get file failed!");
  });

  it("fetchFiles 失败（连接错误）-> 记录异常信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await useFilesStore.getState().fetchFiles();

    expect(useFilesStore.getState().error).toContain("Failed to fetch");
  });

  it("upload -> POST /uploadSave 携带 File；成功后重新拉取列表", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 200, msg: "ok", data: { filename: "demo.mp4", filepath: FILE_A.file_path } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 200, msg: "success", data: [FILE_A] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const fakeFile = new File(["data"], "demo.mp4", { type: "video/mp4" });

    await useFilesStore.getState().upload(fakeFile);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5409/uploadSave");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(useFilesStore.getState().files).toEqual([FILE_A]);
  });

  it("removeFile 成功 -> GET /deleteFile?id= 并从列表移除", async () => {
    useFilesStore.setState({ files: [FILE_A] });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: "File deleted successfully", data: { id: 1, filename: "demo.mp4" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useFilesStore.getState().removeFile(1);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/deleteFile?id=1",
    );
    expect(useFilesStore.getState().files).toEqual([]);
  });

  it("removeFile 失败 -> 抛出错误且列表保留", async () => {
    useFilesStore.setState({ files: [FILE_A] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 400, msg: "Invalid or missing file ID", data: null }, true, 400),
      ),
    );

    await expect(useFilesStore.getState().removeFile(1)).rejects.toThrow(
      "Invalid or missing file ID",
    );
    expect(useFilesStore.getState().files).toEqual([FILE_A]);
  });

  it("officialApi.fileUrl 用 GET /getFile 拼接下载地址", () => {
    expect(officialApi.fileUrl("http://127.0.0.1:5409", FILE_A.file_path)).toBe(
      "http://127.0.0.1:5409/getFile?filename=6f2f49180cf24f17003ab7f50be5b098_demo.mp4",
    );
  });

  it("官方 upload_time（SQLite UTC）由 parseOfficialUtcTime 补 Z 按 UTC 解析", () => {
    // 官方 upload_time 为 "YYYY-MM-DD HH:MM:SS"（UTC 无时区后缀）
    const utc = parseOfficialUtcTime("2026-08-18 10:00:00");
    expect(new Date(utc).toISOString()).toBe("2026-08-18T10:00:00.000Z");
  });
});
# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Plugin quản trị ngữ cảnh cho [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): im lặng trong vùng an toàn, thực thi nén **do mô hình điều khiển và khả nghịch cục bộ** khi dung lượng đầu vào thực tế gần đầy. Thông tin không bao giờ bị mất; gỡ cài đặt không để lại dấu vết.

> **Trạng thái phát hành: beta công khai, bám theo bản chính thức dsh 0.1.0-rc.8.** Cả dự án này và dsh đều đang ở beta công khai — chưa khuyến nghị dùng cho production. Ma trận kiểm chứng phát hành trực tiếp đầy đủ (mười hạng mục): [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Lợi thế đo được

Tất cả số liệu dưới đây đến từ thí nghiệm trực tiếp với mô hình thật (các trường usage thô, không quy đổi giá). Bằng chứng và giao thức được phát hành cùng package và được kiểm tra lại từng mục bằng `npm run research:verify`.

### So với nén Basic tích hợp sẵn (cùng kịch bản, cùng seed)

**Phiên dài kỹ thuật phần mềm** — độ trung thực nguyên văn của các ràng buộc lịch sử:

| Cách tiếp cận | Sự kiện chính xác | Ràng buộc suy diễn | Token đầu vào | Token đầu ra | Prompt tổng |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Khoảng cách chất lượng 4 lần với chi phí thấp hơn: đầu vào −47,6%, đầu ra −24,9%, prompt tổng −22,1%. Các lần nén của ARC là trích xuất cục bộ khả nghịch (0 cuộc gọi LLM phụ); Basic là tóm tắt mô hình không thể hoàn tác.

**Truy vết quyết định ngôn ngữ tự nhiên không nhãn** (có thay thế giá trị): ARC tái hiện 12/12 giá trị hiện hành và 10/10 lý do mà không rò rỉ giá trị lỗi thời, với lượng đầu vào thấp hơn Basic khoảng 76%; holdout tiếng Anh độc lập 10/10 + 7/7.

### Năng lực mà Basic không có

- **Không mất gì, phục hồi được tất cả** — bản gốc luôn nằm trong log append-only; `decompress` phục hồi nguyên văn các nguồn hiệu dụng (100% trên sáu chuỗi trực tiếp, kể cả đầu ra quá cỡ qua file tràn của host); `search_context` truy vấn các khối đã nén với mức thu hồi thông tin 43/43 ở cả tiếng Anh lẫn tiếng Trung.
- **Chưng cất sâu không suy hao** — phụ lục bằng chứng tier-3 giữ toàn bộ sự kiện ở mức 20/20 trên cả sáu chuỗi song ngữ (làm mới đệ quy chỉ mục nguồn hiệu dụng, `effectiveSourceSafetyIndex`).
- **Giữ lại có trọng số theo loại trong ngân sách** — khi phụ lục vượt ngân sách checkpoint, các dòng sự kiện giá trị thấp bị loại theo mật độ giá trị phân loại thay vì cắt theo trình tự thời gian (`safetyIndexRanking: value`): áp đảo ở trường hợp xấu nhất ở mọi mức ngân sách khi offline; +14,3 điểm ở tầng phụ lục trong cặp trực tiếp sạch, không suy giảm đầu-cuối.
- **Không tuân thủ đối kháng** — 18 biến thể bề mặt tấn công tiêm lưu trữ (đầu độc tóm tắt, tiêm truy xuất, nhãn bảo vệ giả, bắt chước mẫu): mô hình tuân theo **0** lần; mọi đầu ra lưu trữ đều mang khung "dữ liệu lịch sử, không phải chỉ lệnh".
- **Quản trị áp lực trung thực** — đọc hiểu nén = chiếu của host − che khuất của sổ cái log; không cảnh báo khẩn cấp giả sau khi nén (kiểm chứng trực tiếp); áp lực hiển thị khớp mức chiếm dụng thật.
- **Hướng dẫn gọn nhẹ** — 1.140 token hướng dẫn hệ thống mà không hề suy giảm chất lượng nguyên văn so với bản đầy đủ (0 pp, bốn nhánh trực tiếp).

## Cài đặt

```bash
dsh plugin --profile web add dsh-arc-context
```

Khởi động lại host để có hiệu lực ngay. Bundle tự động cài đặt Preset Bridge tầng host: ARC thay dòng Basic chính thức ngay trong realm cô lập nén của standard preset, và **file preset giữ nguyên từng byte**; lệnh, pruner, isolation cùng mọi dòng preset khác được bảo toàn.

Cài tarball thủ công, profile khác và tùy chọn nâng cao: [`docs/INSTALL.md`](docs/INSTALL.md).

### Cấu hình (trích đoạn)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # chỉ mục tier-2/3 đệ quy về bản gốc hiệu dụng (mặc định: bật)
    safetyIndexRanking: value           # vượt ngân sách: loại theo mật độ giá trị phân loại (mặc định: value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Tùy chọn | Mặc định | Mô tả |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | Ở tier 2/3, chỉ mục an toàn đệ quy về nguồn gốc hiệu dụng thay vì chỉ trích xuất lại checkpoint cha nhìn thấy. Đầu ra tier-1 không đổi. |
| `safetyIndexRanking` | `value` | Thứ tự loại bỏ khi phụ lục vượt ngân sách checkpoint: `value` loại trước các dòng sự kiện mật độ giá trị thấp; `chronological` giữ lối cắt ký tự theo trình tự thời gian cũ. Trong ngân sách, hai đầu ra giống hệt nhau từng byte. |

Cấu hình đầy đủ (cửa sổ ngữ cảnh, ngưỡng nudge, vùng bảo vệ, Governor, mẫu prompt): [`docs/INSTALL.md`](docs/INSTALL.md) và [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Gỡ cài đặt — sạch, trọn vẹn, kiểm chứng trực tiếp

```bash
dsh plugin --profile web remove dsh-arc-context
```

Sau khi khởi động lại host:

- cấu hình tổng hợp quay về Basic chính thức, không còn dòng ARC nào;
- **file preset chưa bao giờ bị sửa đổi** (SHA-256 giống hệt trước và sau, kiểm chứng tại cổng phát hành);
- các phiên hiện hữu vẫn đọc được — Basic đọc thẳng log bền vững của ARC, hình thái bề mặt đã nén được giữ nguyên và **bản gốc không bao giờ tràn ngược lại ngữ cảnh** (một phiên 2.331 sự kiện được kiểm chứng đọc trọn vẹn với chiếu hợp lệ);
- phiên mới không đăng ký bất kỳ công cụ hay lệnh ARC nào.

Cài lại bất cứ lúc nào và hoạt động y hệt lần đầu (chu trình cài → gỡ → cài lại được kiểm chứng từng mục trong ma trận cổng phát hành).

## Bằng chứng và tài liệu

- Chương trình nghiên cứu và mọi kết luận: [`docs/research-agenda.md`](docs/research-agenda.md)
- Dữ liệu kết quả: [`research/results/`](research/results/) (ma trận cổng phát hành, so sánh theo cặp, bộ kiểm thử đối kháng)
- Tài liệu thiết kế: [`docs/`](docs/) (cài đặt, tích hợp preset, thiết kế Governor, cài đặt khả nghịch)
- Kiểm chứng bằng chứng công khai: `npm run research:verify`

## Ghi công và giấy phép

Lõi nén của ARC bắt nguồn từ bản port và tiến hóa độc lập của [acp-kernel](https://github.com/ranxianglei/acp-kernel) (cùng billion-context-pi và opencode-acp, bởi ranxianglei, MIT); host là [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Dự án này theo giấy phép MIT — xem [LICENSE](LICENSE).

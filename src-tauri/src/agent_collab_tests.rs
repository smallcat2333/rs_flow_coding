//! 模块协作确定性验证：不启动真实 Claude、不调用模型、不触碰用户会话和剪贴板。

use super::*;

/// 构造已授权的协作请求，测试状态机本身而不是模拟其实现。
fn task(id: &str, from: &str, to: &str) -> Request {
    Request { id: id.into(), from: from.into(), to: to.into(), from_title: from.into(), module: r"E:\work\docs\flow\查询.drawio".into(),
        feat: "Feat_261106_1".into(), task: None, goal: "增加查询条件".into(), contract: "增加 status 参数".into(), acceptance: "原有调用仍正常".into(),
        phase: Phase::Queued, detail: String::new(), files: vec![], verification: String::new(), created_at: 0, updated_at: 0 }
}

/// 构造离线/忙碌/空闲目标快照，无需创建 ConPTY。
fn endpoint(running: bool, idle: bool) -> Endpoint { Endpoint { running, idle, unavailable: None, disabled: None } }

/// 构造接收方状态回报；done 默认带验证证据，可在拒绝场景中明确去掉。
fn report(request: &str, state: &str) -> Report {
    Report { request: request.into(), state: state.into(), text: "接口已处理".into(), files: vec![], verification: "查询回归通过".into() }
}

/// 已投递的模块任务和其声明范围，供接单、完成及越界校验使用。
fn delivered() -> Book {
    let mut r = task("request-1", "feat", "module"); r.phase = Phase::Delivered;
    Book { scopes: HashMap::from([("module".into(), Scope { description: "查询模块".into(), paths: vec![r"E:\work\src\query".into()] })]), requests: vec![r], ..Book::default() }
}

/// 生成只含必要元数据的真实 Entry，验证负责人定位不依赖 UI 名称推断。
fn entry(id: &str, title: &str, cwd: &str, feat: &str, flow: &str) -> Entry {
    Entry { meta: Meta { id: id.into(), title: title.into(), cwd: cwd.into(), app: "app".into(), feat: feat.into(), feat_code: String::new(),
        links: if flow.is_empty() { vec![] } else { vec![NodeRef { flow: flow.into(), node: String::new() }] }, pinned: false, pin_at: 0, created: 0, started: false,
        cli_session_id: String::new(), archived_at: 0, stored_at: 0, storage_override: None }, live: idle_live(), acts: VecDeque::new(), queue: VecDeque::new(), proc: None,
        buf: String::new(), seq: 0, gen: 0, stopping: false, idle_since: 0, compacting: false, interrupt_requested: false, tools: Vec::new() }
}

/// 职责目录比较必须保留路径边界，并统一 Windows 大小写和分隔符。
#[test]
fn paths_keep_module_boundaries() {
    assert!(contains(r"E:\work\src\query", "e:/work/src/query/a.rs"));
    assert!(!contains(r"E:\work\src\query", "e:/work/src/query2/a.rs"));
    assert!(contains(r"E:\work\src\query", "E:/work/src/query"));
}

/// 离线负责人只预留一次启动；真正就绪前不能把启动成功当作投递或完成。
#[test]
fn offline_owner_starts_once_then_waits_for_ready() {
    let mut b = Book { requests: vec![task("request-1", "feat", "module"), task("request-2", "feat", "module")], ..Book::default() };
    let mut eps = HashMap::from([("module".into(), endpoint(false, false))]);
    assert_eq!(b.plan(&eps, 1), vec![Action::Start { target: "module".into(), key: "request-1".into(), notice: false }]);
    assert!(b.plan(&eps, 2).is_empty());
    eps.insert("module".into(), endpoint(true, false));
    assert!(b.plan(&eps, 3).is_empty());
    eps.insert("module".into(), endpoint(true, true));
    assert!(matches!(b.plan(&eps, 4).as_slice(), [Action::Deliver { key, .. }] if key == "request-1"));
    assert_eq!(b.requests[0].phase, Phase::Delivered);
    assert_eq!(b.requests[1].phase, Phase::Queued);
    assert!(b.plan(&eps, 5).is_empty());
}

/// 运行中或等待权限的会话不会收到任何终端输入。
#[test]
fn busy_owner_keeps_request_queued() {
    let mut b = Book { requests: vec![task("request-1", "feat", "module")], ..Book::default() };
    assert!(b.plan(&HashMap::from([("module".into(), endpoint(true, false))]), 1).is_empty());
    assert_eq!(b.requests[0].phase, Phase::Queued);
}

/// 停止中的负责人不会被自动拉起，与待用户确认的收纳/归档分支区分。
#[test]
fn stopping_owner_is_blocked_without_starting() {
    let mut b = Book { requests: vec![task("request-1", "feat", "module")], ..Book::default() };
    let ep = Endpoint { unavailable: Some("会话正在停止".into()), ..endpoint(false, false) };
    let eps = HashMap::from([("module".into(), ep), ("feat".into(), endpoint(true, false))]);
    assert!(b.plan(&eps, 1).is_empty());
    assert_eq!(b.requests[0].phase, Phase::Blocked);
    assert_eq!(b.requests[0].detail, "会话正在停止");
}

/// 接单、处理中和完成分别记录；没有验证证据时完成校验不改变原有状态。
#[test]
fn completion_requires_acceptance_and_verification() {
    let mut b = delivered();
    assert!(b.report("module", &report("request-1", "done"), 1).unwrap_err().contains("先用 reply accept"));
    b.report("module", &report("request-1", "accept"), 2).unwrap();
    b.report("module", &report("request-1", "run"), 3).unwrap();
    let before = b.clone();
    let mut done = report("request-1", "done"); done.verification.clear();
    assert!(b.report("module", &done, 4).unwrap_err().contains("--verify"));
    assert_eq!(b, before);
    done.verification = "cargo test 查询回归通过".into();
    b.report("module", &done, 5).unwrap();
    assert_eq!(b.requests[0].phase, Phase::Completed);
    assert_eq!(b.notices.len(), 1);
    assert!(b.report("module", &done, 6).is_err());
    assert_eq!(b.notices.len(), 1);
}

/// 其他 Agent 无权替接收方声称完成；缺少模块职责不能接单后再绕开边界。
#[test]
fn report_checks_recipient_and_declared_scope() {
    let mut b = delivered();
    assert!(b.report("stranger", &report("request-1", "accept"), 1).is_err());
    b.scopes.clear();
    assert!(b.report("module", &report("request-1", "accept"), 2).unwrap_err().contains("scope"));
    b.report("module", &report("request-1", "blocked"), 3).unwrap();
    assert_eq!(b.requests[0].phase, Phase::Blocked);
}

/// 跨模块改动按约定协调，完成回报保留真实文件，不以分工建议伪造文件权限沙箱。
#[test]
fn changed_files_are_reported_without_write_scope_gate() {
    let mut b = delivered();
    b.report("module", &report("request-1", "accept"), 1).unwrap();
    let mut done = report("request-1", "done"); done.files = vec![r"E:\work\src\query2\a.rs".into()];
    b.report("module", &done, 2).unwrap();
    assert_eq!(b.requests[0].files, done.files);
    assert_eq!(b.requests[0].phase, Phase::Completed);
}

/// 未显式回报就结束不能被认为完成；受阻通知只生成一次。
#[test]
fn stop_without_report_is_not_success() {
    let mut b = delivered();
    b.stopped("module", 1); b.stopped("module", 2);
    assert_eq!(b.requests[0].phase, Phase::Blocked);
    assert_eq!(b.notices.len(), 1);
}

/// 有下游依赖时保留模块处理名额，结果通知能恢复原负责人且不生成新的协作请求。
#[test]
fn downstream_result_resumes_waiting_owner_without_reply_loop() {
    let mut b = delivered();
    b.requests.push(task("request-2", "module", "child"));
    b.stopped("module", 1);
    assert_eq!(b.requests[0].phase, Phase::Waiting);
    b.block("request-2", "下游接口受阻", 2);
    let eps = HashMap::from([("module".into(), endpoint(true, true)), ("child".into(), endpoint(true, false)), ("feat".into(), endpoint(true, false))]);
    let actions = b.plan(&eps, 3);
    assert!(matches!(actions.as_slice(), [Action::Deliver { notice: true, target, .. }] if target == "module"));
    assert_eq!(b.requests.len(), 2);
    assert_eq!(b.requests[0].phase, Phase::Waiting);
}

/// 启动失败及就绪超时进入受阻，不在每个调度周期重复启动。
#[test]
fn startup_timeout_does_not_restart_forever() {
    let mut b = Book { requests: vec![task("request-1", "feat", "module")], ..Book::default() };
    let eps = HashMap::from([("module".into(), endpoint(false, false)), ("feat".into(), endpoint(true, false))]);
    b.plan(&eps, 1);
    assert!(b.plan(&eps, 30_002).is_empty());
    assert_eq!(b.requests[0].phase, Phase::Blocked);
    assert!(b.requests[0].detail.contains("超时"));
    assert!(b.plan(&eps, 60_004).is_empty());
}

/// 任务交付后进程退出保留未知结果，不能自动启动再执行一次。
#[test]
fn process_exit_blocks_delivered_work() {
    let mut b = delivered();
    let eps = HashMap::from([("module".into(), endpoint(false, false)), ("feat".into(), endpoint(true, false))]);
    assert!(b.plan(&eps, 1).is_empty());
    assert_eq!(b.requests[0].phase, Phase::Blocked);
}

/// 应用重启保留未投递任务，但已执行的任务进入待核对终态；账本可完整往返序列化。
#[test]
fn persisted_requests_recover_without_reexecution() {
    let mut b = delivered(); b.requests.push(task("request-2", "feat", "module"));
    let text = serde_json::to_string(&b).unwrap();
    let mut restored: Book = serde_json::from_str(&text).unwrap();
    restored.recover(1);
    assert_eq!(restored.requests[0].phase, Phase::Blocked);
    assert_eq!(restored.requests[1].phase, Phase::Queued);
    assert_eq!(restored.notices.len(), 1);
}

/// 直接或间接相互请求均被发现，终态依赖不会永久阻止后续协作。
#[test]
fn dependency_cycles_are_rejected() {
    let mut b = Book { requests: vec![task("request-1", "a", "b"), task("request-2", "b", "c")], ..Book::default() };
    assert!(b.cycle("b", "a"));
    assert!(b.cycle("c", "a"));
    assert!(!b.cycle("a", "c"));
    b.requests[1].phase = Phase::Completed;
    assert!(!b.cycle("c", "a"));
}

/// 结果通知唤醒与新任务不能对同一个负责人并发拉起两个进程。
#[test]
fn notice_and_request_share_start_reservation() {
    let mut b = delivered();
    b.block("request-1", "说明受阻", 1);
    b.requests.push(task("request-2", "other", "feat"));
    let eps = HashMap::from([("module".into(), endpoint(false, false)), ("feat".into(), endpoint(false, false))]);
    let first = b.plan(&eps, 2);
    assert_eq!(first.len(), 1);
    assert!(matches!(first[0], Action::Start { notice: true, .. }));
    assert!(b.plan(&eps, 3).is_empty());
}

/// 同名会话和相同 ID 前缀拒绝随机选择，Feat 协调会话不能冒充模块负责人。
#[test]
fn owner_lookup_rejects_ambiguity_and_non_module() {
    let map = HashMap::from([
        ("me".into(), entry("me", "需求", r"E:\work", "feat.md", "")),
        ("same-1".into(), entry("same-1", "查询", r"E:\work", "", "query.drawio")),
        ("same-2".into(), entry("same-2", "查询", r"E:\work", "", "query2.drawio")),
        ("feat".into(), entry("feat", "其他需求", r"E:\work", "other.md", "")),
    ]);
    assert!(target(&map, "me", "查询", true).unwrap_err().contains("歧义"));
    assert!(target(&map, "me", "same-", true).unwrap_err().contains("歧义"));
    assert_eq!(target(&map, "me", "same-1", true).unwrap(), "same-1");
    assert!(target(&map, "me", "feat", true).unwrap_err().contains("图"));
    assert!(target(&map, "me", "missing", true).is_err());
}

/// 报告已删除的文件也能归一路径，不要求为了回报重建被删除内容。
#[test]
fn deleted_file_can_be_reported_and_book_saved() {
    let root = std::env::temp_dir().join(format!("flow-collab-{}", new_uuid()));
    std::fs::create_dir_all(root.join("src")).unwrap();
    let path = report_path(&root.join("src/已删除.rs")).unwrap();
    assert!(contains(&crate::paths::norm(&root).unwrap().to_string_lossy(), &path));
    let b = delivered(); let dest = root.join("collaboration.json");
    save(&dest, &b).unwrap();
    let restored: Book = serde_json::from_str(&std::fs::read_to_string(dest).unwrap()).unwrap();
    assert_eq!(restored, b);
    std::fs::remove_dir_all(root).unwrap();
}

/// 尚未提交的文字和图片占用输入区，终端设备回包不会误判为用户草稿。
#[test]
fn unsent_user_input_blocks_delivery_until_submitted() {
    let id = "draft-fixture";
    on_input(id, "\x1b[1;1R"); assert!(!has_draft(id));
    on_input(id, "正在输入的内容"); assert!(has_draft(id));
    on_input(id, "\x7f"); assert!(has_draft(id), "不能猜测退格后草稿已经为空");
    on_input(id, "\r"); assert!(!has_draft(id));
    on_input(id, "\x1bv"); assert!(has_draft(id), "原生图片附件也占用草稿");
    input_submitted(id); assert!(!has_draft(id));
}

/// 职责重叠必须报错，收纳仍占职责，归档才释放；相邻目录可分别负责。
#[test]
fn scope_overlap_requires_a_single_owner() {
    let mut map = HashMap::from([("other".into(), entry("other", "公共模块", "E:/work", "", "common.drawio"))]);
    let b = Book { scopes: HashMap::from([("other".into(), Scope { description: "公共接口".into(), paths: vec!["E:/work/src/common".into()] })]), ..Book::default() };
    assert!(check_scope(&b, &map, "module", &["E:/work/src/common/a.rs".into()]).is_err());
    assert!(check_scope(&b, &map, "module", &["E:/work/src/common2".into()]).is_ok());
    map.get_mut("other").unwrap().meta.stored_at = 1;
    assert!(check_scope(&b, &map, "module", &["E:/work/src".into()]).is_err());
    map.get_mut("other").unwrap().meta.archived_at = 1;
    assert!(check_scope(&b, &map, "module", &["E:/work/src".into()]).is_ok());
}

/// 规范图路径和相对图路径均能唯一找到负责人，停用时明确返回原因。
#[test]
fn owner_lookup_resolves_graph_paths_and_disabled_states() {
    let root = std::env::temp_dir().join(format!("flow-owner-{}", new_uuid()));
    std::fs::create_dir_all(root.join("docs/flow")).unwrap();
    let flow = root.join("docs/flow/数据查询.drawio"); std::fs::write(&flow, "<mxfile/>").unwrap();
    let cwd = root.to_string_lossy().into_owned();
    let mut map = HashMap::from([("me".into(), entry("me", "需求", &cwd, "feat.md", "")), ("owner".into(), entry("owner", "数据查询", &cwd, "", &flow.to_string_lossy()))]);
    assert_eq!(target(&map, "me", "docs/flow/数据查询.drawio", true).unwrap(), "owner");
    assert_eq!(target(&map, "me", &flow.to_string_lossy(), true).unwrap(), "owner");
    let mut previous = entry("previous", "数据查询", &cwd, "", &flow.to_string_lossy()); previous.meta.archived_at = 1;
    map.insert("previous".into(), previous);
    assert_eq!(target(&map, "me", "docs/flow/数据查询.drawio", true).unwrap(), "owner", "归档历史不能遮挡当前图主");
    assert_eq!(target(&map, "me", "previous", true).unwrap(), "previous");
    map.get_mut("owner").unwrap().meta.stored_at = 1;
    assert_eq!(target(&map, "me", "owner", true).unwrap(), "owner");
    map.get_mut("owner").unwrap().meta.archived_at = 1;
    assert_eq!(target(&map, "me", "owner", true).unwrap(), "owner");
    std::fs::remove_dir_all(root).unwrap();
}

#[path = "agent_collab_resume_tests.rs"]
mod resume;

#[cfg(windows)]
#[path = "agent_collab_native_test.rs"]
mod native;

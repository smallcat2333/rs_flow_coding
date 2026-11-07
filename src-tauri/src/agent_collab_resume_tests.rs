//! 自动图主创建及用户确认续接的确定性自验；仅临时文件/内存表，不弹窗、不启停真实会话。

use super::*;

/// 临时 APP 的有效模块图；夹具结束只删除本测试创建的目录。
struct Graph { root: PathBuf, flow: PathBuf }
impl Graph {
    /// 创建独立 B APP 及原生未压缩图，供跨 APP 路由和来源推导使用。
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("flow-resume-{}", new_uuid()));
        let flow = root.join("app_b/docs/flow/查询.drawio");
        std::fs::create_dir_all(flow.parent().unwrap()).unwrap();
        std::fs::write(&flow, crate::flow::blank_diagram("查询")).unwrap();
        Self { root, flow }
    }
    /// 返回规范图路径，避免 Windows 临时路径短名影响绑定断言。
    fn path(&self) -> String { crate::paths::norm(&self.flow).unwrap().to_string_lossy().into_owned() }
}
impl Drop for Graph {
    /// 不访问用户项目、配置或实际会话目录。
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
}

/// 构造同图主的收纳或归档状态，保留已有 CLI 身份以验证恢复不会换会话。
fn disabled_map(archived: bool) -> HashMap<String, Entry> {
    let mut owner = entry("module", "查询", "E:/work", "", "E:/work/docs/flow/查询.drawio");
    owner.meta.started = true; owner.meta.cli_session_id = "original-cli-id".into();
    owner.meta.storage_override = Some(true); owner.meta.stored_at = 10;
    if archived { owner.meta.archived_at = 20; }
    HashMap::from([("module".into(), owner), ("feat".into(), entry("feat", "需求", "E:/work", "feat.md", ""))])
}

/// 以真实元数据生成停用快照并预留唯一确认，不运行确认动作本身。
fn await_approval(book: &mut Book, map: &HashMap<String, Entry>) -> String {
    let actions = book.plan(&endpoints(map), 100);
    assert!(matches!(actions.as_slice(), [Action::Confirm { target, .. }] if target == "module"));
    book.approvals["module"].id.clone()
}

/// 有效 B 图从无到有时，工作目录/APP/图绑定均取 B，重复请求复用同一记录而不启动进程。
#[test]
fn valid_unowned_graph_creates_owner_at_its_own_app() {
    let graph = Graph::new();
    let mut map = HashMap::from([("me".into(), entry("me", "A需求", &graph.root.to_string_lossy(), "a.md", ""))]);
    let (id, created) = ensure_target(&mut map, "me", &graph.path(), true).unwrap();
    assert!(created);
    let owner = &map[&id];
    assert_eq!(owner.meta.title, "查询");
    assert_eq!(owner.meta.app, "app_b");
    assert_eq!(owner.meta.cwd, crate::paths::norm(&graph.root.join("app_b")).unwrap().to_string_lossy());
    assert_eq!(source_of(&owner.meta), ("flow", graph.path().as_str()));
    assert!(!owner.meta.started && owner.proc.is_none());
    assert_eq!(ensure_target(&mut map, "me", &graph.path(), true).unwrap(), (id.clone(), false));
    assert_eq!(map.len(), 2);
    let mut book = Book { requests: vec![task("original", "me", &id)], ..Book::default() };
    assert!(matches!(book.plan(&endpoints(&map), 1).as_slice(), [Action::Start { target, key, .. }] if target == &id && key == "original"));
}

/// 并发同图请求在同一锁中查找及创建，只能产生一个唯一图主。
#[test]
fn concurrent_graph_requests_reuse_single_owner() {
    let graph = Graph::new();
    let map = std::sync::Arc::new(Mutex::new(HashMap::from([("me".into(), entry("me", "A", &graph.root.to_string_lossy(), "a.md", ""))])));
    let workers: Vec<_> = (0..8).map(|_| {
        let map = map.clone(); let flow = graph.path();
        std::thread::spawn(move || ensure_target(&mut map.lock().unwrap(), "me", &flow, true).unwrap())
    }).collect();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|(_, created)| *created).count(), 1);
    assert!(results.iter().all(|(id, _)| id == &results[0].0));
    assert_eq!(map.lock().unwrap().len(), 2);
}

/// 未知名称、丢失图、坏 XML、伪图和普通 send 都不能触发猜测创建。
#[test]
fn invalid_or_ambiguous_destinations_never_create_agents() {
    let graph = Graph::new();
    let cwd = graph.root.to_string_lossy().into_owned();
    let mut map = HashMap::from([("me".into(), entry("me", "A", &cwd, "a.md", ""))]);
    for to in ["未知模块", "missing.drawio", "app_b/docs/flow/missing.drawio"] {
        assert!(ensure_target(&mut map, "me", to, true).is_err());
    }
    assert!(ensure_target(&mut map, "me", &graph.path(), false).is_err());
    std::fs::write(&graph.flow, "broken XML").unwrap();
    assert!(ensure_target(&mut map, "me", &graph.path(), true).is_err());
    std::fs::write(&graph.flow, "<other/>").unwrap();
    assert!(ensure_target(&mut map, "me", &graph.path(), true).is_err());
    std::fs::write(&graph.flow, crate::flow::blank_diagram("查询")).unwrap();
    for id in ["other1", "other2"] { map.insert(id.into(), entry(id, "查询.drawio", &cwd, "f.md", "")); }
    assert!(ensure_target(&mut map, "me", "查询.drawio", true).is_err());
    assert_eq!(map.len(), 3);
}

/// 归档历史和收纳负责人均定位原记录；从未创建分支不能绕过它们另建负责人。
#[test]
fn disabled_owner_is_reused_instead_of_recreated() {
    let graph = Graph::new();
    let flow = graph.path();
    let mut map = HashMap::from([("me".into(), entry("me", "A", &graph.root.to_string_lossy(), "a.md", "")), ("module".into(), entry("module", "B", &graph.root.to_string_lossy(), "", &flow))]);
    for archived in [false, true] {
        let owner = map.get_mut("module").unwrap(); owner.meta.stored_at = 1; owner.meta.archived_at = if archived { 2 } else { 0 };
        assert_eq!(ensure_target(&mut map, "me", &flow, true).unwrap(), ("module".into(), false));
        assert_eq!(map.len(), 2);
    }
}

/// 收纳 YES 和归档 YES 恢复同一 CLI 身份，原请求及后续请求先排队，再按空闲状态依次送达。
#[test]
fn stored_and_archived_yes_resume_original_requests_in_order() {
    for archived in [false, true] {
        let mut map = disabled_map(archived);
        let mut book = Book { requests: vec![task("first", "feat", "module"), task("second", "feat", "module")], ..Book::default() };
        let key = await_approval(&mut book, &map);
        let original = book.requests[0].clone();
        assert!(book.plan(&endpoints(&map), 101).is_empty(), "等待时不能重复弹窗或启动");
        assert!(book.decide_approval(&mut map, "module", &key, Ok(true), 102));
        let owner = &map["module"];
        assert_eq!((owner.meta.archived_at, owner.meta.stored_at), (0, 0));
        assert_eq!(owner.meta.storage_override, None);
        assert_eq!(owner.meta.cli_session_id, "original-cli-id");
        assert!(owner.proc.is_none(), "确认阶段不启动进程");
        assert_eq!(book.requests[0].id, original.id);
        assert_eq!(book.requests[0].goal, original.goal);
        assert_eq!(book.requests[0].acceptance, original.acceptance);
        let mut eps = endpoints(&map);
        assert!(matches!(book.plan(&eps, 103).as_slice(), [Action::Start { key, .. }] if key == "first"));
        eps.insert("module".into(), endpoint(true, false));
        assert!(book.plan(&eps, 104).is_empty());
        eps.insert("module".into(), endpoint(true, true));
        assert!(matches!(book.plan(&eps, 105).as_slice(), [Action::Deliver { key, .. }] if key == "first"));
        assert_eq!(book.requests[1].phase, Phase::Queued);
    }
}

/// 收纳 NO、归档 NO 及确认窗口错误均保持停用，并向请求方反馈所有等待请求，不再次弹窗。
#[test]
fn stored_archived_no_or_cancel_never_start_and_notify_requester() {
    for archived in [false, true] {
        for answer in [Ok(false), Err("确认窗口被关闭".into())] {
            let mut map = disabled_map(archived);
            let before = serde_json::to_value(&map["module"].meta).unwrap();
            let mut book = Book { requests: vec![task("first", "feat", "module"), task("second", "feat", "module")], ..Book::default() };
            let key = await_approval(&mut book, &map);
            assert!(!book.decide_approval(&mut map, "module", &key, answer, 102));
            assert_eq!(serde_json::to_value(&map["module"].meta).unwrap(), before);
            assert!(map["module"].proc.is_none());
            assert!(book.requests.iter().all(|r| r.phase == Phase::Blocked));
            assert_eq!(book.notices.len(), 2);
            assert!(book.approvals.is_empty());
            assert!(book.plan(&endpoints(&map), 103).iter().all(|a| !matches!(a, Action::Start { target, .. } | Action::Confirm { target, .. } if target == "module")));
        }
    }
}

/// 等待期间新增请求共享已有确认，重启保留正文并反馈受阻，不自动重复提示或执行。
#[test]
fn waiting_confirmation_is_deduplicated_and_persisted() {
    let map = disabled_map(false);
    let mut book = Book { requests: vec![task("first", "feat", "module")], ..Book::default() };
    await_approval(&mut book, &map);
    book.requests.push(task("second", "feat", "module"));
    assert!(book.plan(&endpoints(&map), 101).is_empty());
    assert_eq!(book.requests[1].phase, Phase::AwaitingApproval);
    let text = serde_json::to_string(&book).unwrap();
    let mut restored: Book = serde_json::from_str(&text).unwrap();
    assert_eq!(book, restored);
    restored.recover(102);
    assert!(restored.approvals.is_empty());
    assert_eq!(restored.requests[0].goal, book.requests[0].goal);
    assert!(restored.requests.iter().all(|r| r.phase == Phase::Blocked));
    assert_eq!(restored.notices.len(), 2);
}

/// 用户 YES 仍不能恢复被另一图主接任的归档记录；拒绝时原停用数据和新负责人都不变。
#[test]
fn archived_restore_conflict_is_reported_without_partial_enable() {
    let mut map = disabled_map(true);
    let mut book = Book { requests: vec![task("first", "feat", "module")], ..Book::default() };
    let key = await_approval(&mut book, &map);
    map.insert("new-owner".into(), entry("new-owner", "新负责人", "E:/work", "", "E:/work/docs/flow/查询.drawio"));
    let before = serde_json::to_value(&map["module"].meta).unwrap();
    assert!(!book.decide_approval(&mut map, "module", &key, Ok(true), 102));
    assert_eq!(serde_json::to_value(&map["module"].meta).unwrap(), before);
    assert_eq!(book.requests[0].phase, Phase::Blocked);
    assert!(book.requests[0].detail.starts_with("DUP:new-owner:"));
    assert_eq!(book.notices.len(), 1);
    assert!(map.values().all(|e| e.proc.is_none()));
}

/// 等待后又被手动停用的另一轮状态不受旧 YES 影响；Agent 回报不能代替用户确认。
#[test]
fn stale_approval_and_agent_yes_cannot_enable_owner() {
    let mut map = disabled_map(false);
    let mut book = Book { requests: vec![task("first", "feat", "module")], ..Book::default() };
    let key = await_approval(&mut book, &map);
    let mut yes = report("first", "YES");
    assert!(book.report("module", &yes, 101).is_err());
    yes.state = "accept".into();
    assert!(book.report("module", &yes, 101).is_err());
    assert!(!book.decide_approval(&mut map, "module", "unrelated-key", Ok(true), 101));
    assert_eq!(map["module"].meta.stored_at, 10);
    map.get_mut("module").unwrap().meta.stored_at = 30;
    assert!(!book.decide_approval(&mut map, "module", &key, Ok(true), 102));
    assert_eq!(map["module"].meta.stored_at, 30);
    assert!(book.requests[0].detail.contains("停用状态已变化"));
}

/// 关闭 Feat 的收纳协调会话经用户启用后沿用手动覆盖，自动同步不会马上把它收回。
#[test]
fn user_yes_preserves_manual_enable_override_for_closed_feat() {
    let graph = Graph::new();
    let feat = graph.root.join("Feat_test.md");
    std::fs::write(&feat, "# 测试\n\n> 状态：已关闭\n").unwrap();
    let mut map = disabled_map(true);
    map.get_mut("module").unwrap().meta.feat = feat.to_string_lossy().into_owned();
    let mut book = Book { requests: vec![task("first", "feat", "module")], ..Book::default() };
    let key = await_approval(&mut book, &map);
    assert!(book.decide_approval(&mut map, "module", &key, Ok(true), 102));
    assert_eq!(map["module"].meta.storage_override, Some(false));
    sync_storage(map.get_mut("module").unwrap(), 103);
    assert_eq!(map["module"].meta.stored_at, 0);
}

/// 进程停止期间先等待退出，旧 stopping 标志不应使已确认启用的离线会话永久受阻。
#[test]
fn confirmed_queue_waits_for_process_exit_then_starts() {
    let mut map = disabled_map(false);
    map.get_mut("module").unwrap().stopping = true;
    let mut book = Book { requests: vec![task("first", "feat", "module")], ..Book::default() };
    let key = await_approval(&mut book, &map);
    assert!(book.decide_approval(&mut map, "module", &key, Ok(true), 102));
    let mut eps = endpoints(&map);
    eps.insert("module".into(), Endpoint { unavailable: Some("会话正在停止".into()), ..endpoint(true, false) });
    assert!(book.plan(&eps, 103).is_empty());
    assert_eq!(book.requests[0].phase, Phase::Queued);
    assert!(matches!(book.plan(&endpoints(&map), 104).as_slice(), [Action::Start { .. }]));
}

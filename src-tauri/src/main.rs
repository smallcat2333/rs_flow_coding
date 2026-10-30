// 发布版隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rs_flow_coding_lib::run()
}

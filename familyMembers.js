app.get("/api/family-members/:owner_id", async (req, res) => {
  try {
    const { owner_id } = req.params;

    const members = await dbAll(
      `SELECT 
         fm.id,
         fm.name AS invited_name,
         fm.whatsapp_number,
         
         u.id AS user_id,
         u.name AS user_name,
         u.whatsapp_number AS user_whatsapp
       FROM family_members fm
       LEFT JOIN users u ON u.id = fm.member_id
       WHERE fm.owner_id = ?`,
      [owner_id]
    );

    const formatted = members.map((m) => ({
      id: m.id,
      isLinked: !!m.user_id,
      name: m.user_id ? m.user_name : m.invited_name,
      phone: m.user_id ? m.user_whatsapp : m.whatsapp_number,
      member_id: m.user_id,
    }));

    res.json(formatted);
  } catch (err) {
    console.log("❌ Erro ao buscar membros:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

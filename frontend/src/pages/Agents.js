import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Slider,
  Switch,
  FormControlLabel,
  Chip,
  IconButton,
  Tooltip,
  Alert,
  Drawer,
  CardActions,
  Avatar,
  Badge,
  InputAdornment,
  Divider,
  Stack,
  LinearProgress,
  useTheme,
  useMediaQuery,
  Paper,
  Collapse,
  Fab,
  Snackbar,
} from '@mui/material';
import {
  Edit as EditIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  Phone as PhoneIcon,
  Settings as SettingsIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
  Sort as SortIcon,
  PlayArrow as TestIcon,
  Close as CloseIcon,
  Speed as SpeedIcon,
  Psychology as PsychologyIcon,
  Language as LanguageIcon,
  VolumeUp as VoiceIcon,
  Analytics as StatsIcon,
  Schedule as DurationIcon,
  SentimentSatisfied as SentimentIcon,
  Call as CallIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
  Person as PersonIcon,
} from '@mui/icons-material';
import { agentsApi } from '../services/api';

const Agents = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  
  // State management
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState(null);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [filterVoice, setFilterVoice] = useState('');
  const [filterLanguage, setFilterLanguage] = useState('');
  const [filterResponsiveness, setFilterResponsiveness] = useState('');
  const [testingAgent, setTestingAgent] = useState(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  // Mock usage statistics for agents
  const [agentStats, setAgentStats] = useState({});

  useEffect(() => {
    fetchAgents();
    generateMockStats();
  }, []);

  const fetchAgents = async () => {
    try {
      setLoading(true);
      const agentsData = await agentsApi.getAgents();
      setAgents(agentsData || []);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
      // Use enhanced mock data with more variety
      setAgents(generateEnhancedMockAgents());
    } finally {
      setLoading(false);
    }
  };

  const generateMockStats = () => {
    const stats = {};
    ['1', '2', '3', '4'].forEach(id => {
      stats[id] = {
        callsHandled: Math.floor(Math.random() * 500) + 50,
        avgDuration: Math.floor(Math.random() * 300) + 120, // 2-8 minutes
        sentimentScore: (Math.random() * 2 - 1).toFixed(2), // -1 to 1
        successRate: Math.floor(Math.random() * 30) + 70, // 70-100%
        lastUsed: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toLocaleDateString(),
      };
    });
    setAgentStats(stats);
  };

  const generateEnhancedMockAgents = () => [
    {
      agent_id: '1',
      agent_name: 'Medical Receptionist',
      voice_id: 'sarah',
      voice_temperature: 0.7,
      voice_speed: 1.0,
      responsiveness: 0.85,
      interruption_sensitivity: 0.5,
      enable_backchannel: true,
      backchannel_frequency: 0.3,
      language: 'en-US',
      prompt: 'You are a helpful medical receptionist AI assistant. Your primary responsibilities include scheduling appointments, answering basic medical questions, verifying insurance information, and directing patients to appropriate healthcare resources. Always maintain a professional, empathetic, and patient-friendly demeanor.',
      status: 'active',
    },
    {
      agent_id: '2',
      agent_name: 'Emergency Triage',
      voice_id: 'michael',
      voice_temperature: 0.5,
      voice_speed: 1.1,
      responsiveness: 0.95,
      interruption_sensitivity: 0.7,
      enable_backchannel: false,
      backchannel_frequency: 0.1,
      language: 'en-US',
      prompt: 'You are an emergency medical triage AI specialist. Quickly assess the urgency of medical situations, provide appropriate guidance for emergency care, and prioritize cases based on severity. Always remain calm and provide clear, actionable instructions for emergency situations.',
      status: 'active',
    },
    {
      agent_id: '3',
      agent_name: 'Billing Support',
      voice_id: 'emily',
      voice_temperature: 0.6,
      voice_speed: 0.9,
      responsiveness: 0.6,
      interruption_sensitivity: 0.4,
      enable_backchannel: true,
      backchannel_frequency: 0.4,
      language: 'en-US',
      prompt: 'You are a medical billing support AI agent. Help patients understand their bills, explain insurance coverage, set up payment plans, and resolve billing inquiries. Be patient and thorough when explaining complex billing information.',
      status: 'active',
    },
    {
      agent_id: '4',
      agent_name: 'Pharmacy Assistant',
      voice_id: 'david',
      voice_temperature: 0.8,
      voice_speed: 1.0,
      responsiveness: 0.3,
      interruption_sensitivity: 0.6,
      enable_backchannel: true,
      backchannel_frequency: 0.2,
      language: 'en-US',
      prompt: 'You are a pharmacy assistant AI focused on medication management, prescription refills, drug interactions, and medication counseling. Provide accurate information about medications while emphasizing the importance of consulting with healthcare providers.',
      status: 'inactive',
    },
  ];

  // Extract keyword tags from prompt
  const extractKeywords = (prompt) => {
    const commonWords = ['you', 'are', 'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'your', 'always', 'provide', 'help', 'assist'];
    const words = prompt.toLowerCase().split(/\s+/)
      .filter(word => word.length > 3 && !commonWords.includes(word))
      .map(word => word.replace(/[^\w]/g, ''));
    
    // Get unique words and return top 4
    const uniqueWords = [...new Set(words)];
    return uniqueWords.slice(0, 4);
  };

  // Get responsiveness color and label
  const getResponsivenessInfo = (responsiveness) => {
    if (!responsiveness && responsiveness !== 0) {
      return { color: 'default', label: 'N/A', percentage: 'N/A' };
    }
    
    const percentage = Math.round(responsiveness * 100);
    
    if (percentage >= 70) {
      return { color: 'success', label: 'High', percentage: `${percentage}%` };
    } else if (percentage >= 40) {
      return { color: 'warning', label: 'Medium', percentage: `${percentage}%` };
    } else {
      return { color: 'error', label: 'Low', percentage: `${percentage}%` };
    }
  };

  // Filtered and sorted agents
  const filteredAndSortedAgents = useMemo(() => {
    let filtered = agents.filter(agent => {
      const matchesSearch = !searchQuery || 
        agent.agent_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.prompt.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesVoice = !filterVoice || agent.voice_id === filterVoice;
      const matchesLanguage = !filterLanguage || agent.language === filterLanguage;
      
      let matchesResponsiveness = true;
      if (filterResponsiveness) {
        const respInfo = getResponsivenessInfo(agent.responsiveness);
        matchesResponsiveness = respInfo.label.toLowerCase() === filterResponsiveness.toLowerCase();
      }

      return matchesSearch && matchesVoice && matchesLanguage && matchesResponsiveness;
    });

    // Sort agents
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.agent_name.localeCompare(b.agent_name);
        case 'responsiveness':
          return (b.responsiveness || 0) - (a.responsiveness || 0);
        case 'voice':
          return a.voice_id.localeCompare(b.voice_id);
        case 'language':
          return a.language.localeCompare(b.language);
        case 'status':
          return a.status.localeCompare(b.status);
        default:
          return 0;
      }
    });

    return filtered;
  }, [agents, searchQuery, filterVoice, filterLanguage, filterResponsiveness, sortBy]);

  const handleEditAgent = (agent) => {
    setEditingAgent({ ...agent });
    setEditDrawerOpen(true);
  };

  const handleSaveAgent = async () => {
    try {
      await agentsApi.updateAgent(editingAgent.agent_id, editingAgent);
      setSuccess('Agent updated successfully');
      setEditDrawerOpen(false);
      setEditingAgent(null);
      fetchAgents();
    } catch (err) {
      setError('Failed to update agent');
    }
  };

  const handleCancelEdit = () => {
    setEditingAgent(null);
    setEditDrawerOpen(false);
  };

  const handleInputChange = (field, value) => {
    setEditingAgent(prev => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleTestAgent = (agent) => {
    setTestingAgent(agent.agent_id);
    // Simulate test call
    setTimeout(() => {
      setTestingAgent(null);
      setSuccess(`Test call completed for ${agent.agent_name}! Check the dashboard for results.`);
    }, 3000);
  };

  const clearFilters = () => {
    setSearchQuery('');
    setFilterVoice('');
    setFilterLanguage('');
    setFilterResponsiveness('');
    setSortBy('name');
  };

  const formatDuration = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const AgentCard = ({ agent }) => {
    const stats = agentStats[agent.agent_id] || {};
    const responsivenessInfo = getResponsivenessInfo(agent.responsiveness);
    const keywords = extractKeywords(agent.prompt);

    return (
      <Card 
        sx={{ 
          height: '100%',
          transition: 'all 0.3s ease',
          '&:hover': {
            transform: 'translateY(-4px)',
            boxShadow: 4,
          },
          border: agent.status === 'active' ? `2px solid ${theme.palette.success.light}` : `2px solid ${theme.palette.grey[300]}`,
        }}
      >
        <CardContent>
          {/* Header */}
          <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2}>
            <Box display="flex" alignItems="center">
              <Avatar 
                sx={{ 
                  mr: 2, 
                  bgcolor: agent.status === 'active' ? 'success.main' : 'grey.400',
                  width: 48,
                  height: 48
                }}
              >
                <PersonIcon />
              </Avatar>
              <Box>
                <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
                  {agent.agent_name}
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  ID: {agent.agent_id}
                </Typography>
              </Box>
            </Box>
            
            <Box display="flex" alignItems="center">
              <Chip
                label={agent.status}
                color={agent.status === 'active' ? 'success' : 'default'}
                size="small"
                sx={{ mr: 1 }}
              />
              <Tooltip title="Edit Agent">
                <IconButton
                  size="small"
                  onClick={() => handleEditAgent(agent)}
                  color="primary"
                >
                  <EditIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>

          {/* Quick Stats Row */}
          <Grid container spacing={1} sx={{ mb: 2 }}>
            <Grid item xs={6}>
              <Tooltip title={`Total calls handled: ${stats.callsHandled || 0}`}>
                <Paper variant="outlined" sx={{ p: 1, textAlign: 'center' }}>
                  <CallIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                  <Typography variant="caption" display="block">
                    {stats.callsHandled || 0} calls
                  </Typography>
                </Paper>
              </Tooltip>
            </Grid>
            <Grid item xs={6}>
              <Tooltip title={`Average call duration: ${formatDuration(stats.avgDuration || 0)}`}>
                <Paper variant="outlined" sx={{ p: 1, textAlign: 'center' }}>
                  <DurationIcon sx={{ fontSize: 16, color: 'info.main' }} />
                  <Typography variant="caption" display="block">
                    {formatDuration(stats.avgDuration || 0)}
                  </Typography>
                </Paper>
              </Tooltip>
            </Grid>
          </Grid>

          {/* Responsiveness Badge */}
          <Box display="flex" alignItems="center" mb={2}>
            <SpeedIcon sx={{ mr: 1, fontSize: 20 }} />
            <Typography variant="body2" sx={{ mr: 1 }}>Responsiveness:</Typography>
            <Chip
              label={`${responsivenessInfo.percentage} (${responsivenessInfo.label})`}
              color={responsivenessInfo.color}
              size="small"
              variant="outlined"
            />
          </Box>

          {/* Voice & Language */}
          <Box sx={{ mb: 2 }}>
            <Box display="flex" alignItems="center" mb={1}>
              <VoiceIcon sx={{ mr: 1, fontSize: 16, color: 'text.secondary' }} />
              <Typography variant="body2">
                Voice: {agent.voice_id} ({agent.voice_speed}x, {agent.voice_temperature}°)
              </Typography>
            </Box>
            <Box display="flex" alignItems="center">
              <LanguageIcon sx={{ mr: 1, fontSize: 16, color: 'text.secondary' }} />
              <Typography variant="body2">
                Language: {agent.language}
              </Typography>
            </Box>
          </Box>

          {/* Keyword Tags */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="textSecondary" gutterBottom>
              Keywords:
            </Typography>
            <Box display="flex" gap={0.5} flexWrap="wrap">
              {keywords.map((keyword, index) => (
                <Chip 
                  key={index}
                  label={keyword}
                  size="small"
                  variant="outlined"
                  sx={{ fontSize: '0.7rem', height: 20 }}
                />
              ))}
            </Box>
          </Box>

          {/* Sentiment & Success Rate */}
          <Grid container spacing={1} sx={{ mb: 2 }}>
            <Grid item xs={6}>
              <Tooltip title={`Average sentiment score: ${stats.sentimentScore || 'N/A'}`}>
                <Box display="flex" alignItems="center">
                  <SentimentIcon sx={{ mr: 0.5, fontSize: 16, color: 'text.secondary' }} />
                  <Typography variant="caption">
                    Sentiment: {stats.sentimentScore || 'N/A'}
                  </Typography>
                </Box>
              </Tooltip>
            </Grid>
            <Grid item xs={6}>
              <Tooltip title={`Success rate: ${stats.successRate || 0}%`}>
                <Box display="flex" alignItems="center">
                  <StatsIcon sx={{ mr: 0.5, fontSize: 16, color: 'text.secondary' }} />
                  <Typography variant="caption">
                    Success: {stats.successRate || 0}%
                  </Typography>
                </Box>
              </Tooltip>
            </Grid>
          </Grid>

          {/* Prompt Preview */}
          <Typography variant="subtitle2" color="textSecondary" gutterBottom>
            Prompt Preview:
          </Typography>
          <Typography 
            variant="body2" 
            sx={{ 
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              fontSize: '0.875rem',
              color: 'text.secondary',
              fontStyle: 'italic'
            }}
          >
            {agent.prompt}
          </Typography>
        </CardContent>

        <CardActions sx={{ justifyContent: 'space-between', px: 2, pb: 2 }}>
          <Button
            size="small"
            startIcon={<TestIcon />}
            onClick={() => handleTestAgent(agent)}
            disabled={testingAgent === agent.agent_id || agent.status !== 'active'}
            variant="outlined"
            color="primary"
          >
            {testingAgent === agent.agent_id ? 'Testing...' : 'Test Agent'}
          </Button>
          
          <Typography variant="caption" color="textSecondary">
            Last used: {stats.lastUsed || 'Never'}
          </Typography>
        </CardActions>

        {/* Loading indicator for testing */}
        {testingAgent === agent.agent_id && (
          <LinearProgress color="primary" />
        )}
      </Card>
    );
  };

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h4" gutterBottom sx={{ mb: 3, fontWeight: 'bold' }}>
        Agent Management
      </Typography>

      {/* Alerts */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Search and Filter Controls */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                label="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>
            
            <Grid item xs={6} md={2}>
              <FormControl fullWidth size="small">
                <InputLabel>Sort by</InputLabel>
                <Select
                  value={sortBy}
                  label="Sort by"
                  onChange={(e) => setSortBy(e.target.value)}
                >
                  <MenuItem value="name">Name</MenuItem>
                  <MenuItem value="responsiveness">Responsiveness</MenuItem>
                  <MenuItem value="voice">Voice</MenuItem>
                  <MenuItem value="language">Language</MenuItem>
                  <MenuItem value="status">Status</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6} md={2}>
              <Button
                variant="outlined"
                onClick={() => setFiltersExpanded(!filtersExpanded)}
                startIcon={<FilterIcon />}
                endIcon={filtersExpanded ? <CollapseIcon /> : <ExpandIcon />}
                fullWidth
              >
                Filters
              </Button>
            </Grid>

            <Grid item xs={12} md={2}>
              <Button
                variant="outlined"
                onClick={clearFilters}
                startIcon={<CloseIcon />}
                fullWidth
              >
                Clear
              </Button>
            </Grid>
          </Grid>

          {/* Expandable Filters */}
          <Collapse in={filtersExpanded}>
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={12} md={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Voice</InputLabel>
                  <Select
                    value={filterVoice}
                    label="Voice"
                    onChange={(e) => setFilterVoice(e.target.value)}
                  >
                    <MenuItem value="">All Voices</MenuItem>
                    <MenuItem value="sarah">Sarah</MenuItem>
                    <MenuItem value="michael">Michael</MenuItem>
                    <MenuItem value="emily">Emily</MenuItem>
                    <MenuItem value="david">David</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} md={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Language</InputLabel>
                  <Select
                    value={filterLanguage}
                    label="Language"
                    onChange={(e) => setFilterLanguage(e.target.value)}
                  >
                    <MenuItem value="">All Languages</MenuItem>
                    <MenuItem value="en-US">English (US)</MenuItem>
                    <MenuItem value="en-GB">English (UK)</MenuItem>
                    <MenuItem value="es-ES">Spanish</MenuItem>
                    <MenuItem value="fr-FR">French</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              <Grid item xs={12} md={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Responsiveness</InputLabel>
                                     <Select
                     value={filterResponsiveness}
                     label="Responsiveness"
                     onChange={(e) => setFilterResponsiveness(e.target.value)}
                   >
                     <MenuItem value="">All Levels</MenuItem>
                     <MenuItem value="high">High (≥70%)</MenuItem>
                     <MenuItem value="medium">Medium (40-69%)</MenuItem>
                     <MenuItem value="low">Low (&lt;40%)</MenuItem>
                   </Select>
                </FormControl>
              </Grid>
            </Grid>
          </Collapse>
        </CardContent>
      </Card>

      {/* Agent Grid */}
      <Typography variant="h6" sx={{ mb: 2 }}>
        {filteredAndSortedAgents.length} Agent{filteredAndSortedAgents.length !== 1 ? 's' : ''}
      </Typography>

      <Grid container spacing={3}>
        {filteredAndSortedAgents.map((agent) => (
          <Grid item xs={12} sm={6} lg={4} key={agent.agent_id}>
            <AgentCard agent={agent} />
          </Grid>
        ))}
      </Grid>

      {filteredAndSortedAgents.length === 0 && !loading && (
        <Paper sx={{ p: 4, textAlign: 'center', mt: 3 }}>
          <Typography variant="h6" color="textSecondary">
            No agents found
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Try adjusting your search or filter criteria
          </Typography>
        </Paper>
      )}

      {/* Enhanced Edit Agent Drawer */}
      <Drawer
        anchor="right"
        open={editDrawerOpen}
        onClose={handleCancelEdit}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100%', sm: '90%', md: '60%', lg: '40%' },
            maxWidth: '800px',
          },
        }}
      >
        {editingAgent && (
          <Box sx={{ p: 3 }}>
            {/* Header */}
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
              <Typography variant="h5" fontWeight="bold">
                Edit Agent: {editingAgent.agent_name}
              </Typography>
              <IconButton onClick={handleCancelEdit}>
                <CloseIcon />
              </IconButton>
            </Box>

            {/* Form Fields */}
            <Stack spacing={3}>
              {/* Basic Info */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>Basic Information</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={12}>
                      <TextField
                        fullWidth
                        label="Agent Name"
                        value={editingAgent.agent_name || ''}
                        onChange={(e) => handleInputChange('agent_name', e.target.value)}
                      />
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <FormControl fullWidth>
                        <InputLabel>Voice</InputLabel>
                        <Select
                          value={editingAgent.voice_id || ''}
                          label="Voice"
                          onChange={(e) => handleInputChange('voice_id', e.target.value)}
                        >
                          <MenuItem value="sarah">Sarah</MenuItem>
                          <MenuItem value="michael">Michael</MenuItem>
                          <MenuItem value="emily">Emily</MenuItem>
                          <MenuItem value="david">David</MenuItem>
                        </Select>
                      </FormControl>
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <FormControl fullWidth>
                        <InputLabel>Language</InputLabel>
                        <Select
                          value={editingAgent.language || ''}
                          label="Language"
                          onChange={(e) => handleInputChange('language', e.target.value)}
                        >
                          <MenuItem value="en-US">English (US)</MenuItem>
                          <MenuItem value="en-GB">English (UK)</MenuItem>
                          <MenuItem value="es-ES">Spanish</MenuItem>
                          <MenuItem value="fr-FR">French</MenuItem>
                        </Select>
                      </FormControl>
                    </Grid>
                  </Grid>
                </CardContent>
              </Card>

              {/* Voice Settings */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>Voice Settings</Typography>
                  <Grid container spacing={3}>
                    <Grid item xs={12} md={6}>
                      <Typography gutterBottom>
                        Voice Temperature: {editingAgent.voice_temperature || 0.7}
                      </Typography>
                      <Slider
                        value={editingAgent.voice_temperature || 0.7}
                        onChange={(e, value) => handleInputChange('voice_temperature', value)}
                        min={0}
                        max={1}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <Typography gutterBottom>
                        Voice Speed: {editingAgent.voice_speed || 1.0}x
                      </Typography>
                      <Slider
                        value={editingAgent.voice_speed || 1.0}
                        onChange={(e, value) => handleInputChange('voice_speed', value)}
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Grid>
                  </Grid>
                </CardContent>
              </Card>

              {/* Behavior Settings */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>Behavior Settings</Typography>
                  <Grid container spacing={3}>
                    <Grid item xs={12} md={6}>
                      <Typography gutterBottom>
                        Responsiveness: {Math.round((editingAgent.responsiveness || 0.8) * 100)}%
                      </Typography>
                      <Slider
                        value={editingAgent.responsiveness || 0.8}
                        onChange={(e, value) => handleInputChange('responsiveness', value)}
                        min={0}
                        max={1}
                        step={0.05}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <Typography gutterBottom>
                        Interruption Sensitivity: {Math.round((editingAgent.interruption_sensitivity || 0.5) * 100)}%
                      </Typography>
                      <Slider
                        value={editingAgent.interruption_sensitivity || 0.5}
                        onChange={(e, value) => handleInputChange('interruption_sensitivity', value)}
                        min={0}
                        max={1}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                      />
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={editingAgent.enable_backchannel || false}
                            onChange={(e) => handleInputChange('enable_backchannel', e.target.checked)}
                          />
                        }
                        label="Enable Backchannel"
                      />
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <Typography gutterBottom>
                        Backchannel Frequency: {Math.round((editingAgent.backchannel_frequency || 0.3) * 100)}%
                      </Typography>
                      <Slider
                        value={editingAgent.backchannel_frequency || 0.3}
                        onChange={(e, value) => handleInputChange('backchannel_frequency', value)}
                        min={0}
                        max={1}
                        step={0.1}
                        marks
                        valueLabelDisplay="auto"
                        disabled={!editingAgent.enable_backchannel}
                      />
                    </Grid>
                  </Grid>
                </CardContent>
              </Card>

              {/* System Prompt */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>System Prompt</Typography>
                  <TextField
                    fullWidth
                    label="System Prompt"
                    multiline
                    rows={6}
                    value={editingAgent.prompt || ''}
                    onChange={(e) => handleInputChange('prompt', e.target.value)}
                    helperText="Define the agent's personality, capabilities, and instructions"
                  />
                </CardContent>
              </Card>
            </Stack>

            {/* Action Buttons */}
            <Box sx={{ mt: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button
                onClick={handleCancelEdit}
                startIcon={<CancelIcon />}
                variant="outlined"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveAgent}
                variant="contained"
                startIcon={<SaveIcon />}
              >
                Save Changes
              </Button>
            </Box>
          </Box>
        )}
      </Drawer>

      {/* Success Snackbar */}
      <Snackbar
        open={!!success}
        autoHideDuration={4000}
        onClose={() => setSuccess(null)}
        message={success}
      />
    </Box>
  );
};

export default Agents; 